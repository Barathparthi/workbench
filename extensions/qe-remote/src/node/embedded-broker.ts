import { basename } from 'node:path';

import {
  createHostKeyVerifier,
  createRemoteFileSystem,
  DomainError,
  fileOperation,
  isDomainError,
  mapSshError,
  messageFor,
  personalCredentials,
  TerminalBridge,
  type AuditSink,
  type ErrorCode,
  type HostKeyStore,
  type PersonalTarget,
  type RemoteFileSystem,
  type SshConnection,
  type SshCredential,
  type SshTransport,
  type TargetSource,
} from '@qe/broker-core';
import type { FsOp } from '@qe/contracts';
import { checkPersonalHost, type Resolver } from '@qe/policy';

import type {
  EmbeddedBrokerClient,
  EmbeddedBrokerService,
  EmbeddedResult,
  HostKeyAnswer,
  PersonalTargetSummary,
} from '../common/embedded-broker-protocol';

export interface EmbeddedBrokerDeps {
  readonly targets: TargetSource & { problems(): Promise<string[]> };
  readonly hostKeys: HostKeyStore;
  readonly audit: AuditSink;
  readonly transport: SshTransport;
  readonly resolver: Resolver;
  /** Networks the organisation forbids (managed settings, Phase 10.6); the user's own network is otherwise fine. */
  readonly deniedCidrs: readonly string[];
  readonly home: string;
  /** The user's SSH agent, if any (`detectAgent()`). */
  readonly agent: string | undefined;
  /** Reads a key file (tests replace it). */
  readonly readKey?: (path: string) => Promise<Buffer | undefined>;
  /** File connections close after this long unused. */
  readonly filesIdleMs?: number;
  /** Whether an unknown host key may be offered to the user (managed setting, Phase 10.6). Default true. */
  readonly trustOnFirstUse?: boolean;
}

interface PresentedKey {
  readonly algorithm: string;
  readonly fingerprintSha256: string;
}

const hostKeyName = (t: PersonalTarget) => `${t.host}:${String(t.port)}`;

/**
 * What the user reads when a personal connect fails. Host-key problems on the user's own hosts are explained the way
 * OpenSSH does (which file, which fingerprint); everything else reads exactly like the hosted broker's message.
 */
export function personalMessage(error: unknown): string {
  const code = failure(error);
  const details = isDomainError(error) ? error.details : undefined;
  const presented = details?.['presented'] as PresentedKey | undefined;
  const key = presented === undefined ? '' : ` (${presented.algorithm} ${presented.fingerprintSha256})`;
  if (code === 'HOST_KEY_MISMATCH') {
    return details?.['revoked'] === true
      ? `The host key${key} is marked @revoked in your known_hosts. Do not connect.`
      : 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Someone could be eavesdropping on you right now, or the host ' +
          `key was just changed. The host presented${key}, which differs from your known_hosts. If the change is ` +
          'expected, remove the old entry from ~/.ssh/known_hosts (or ~/.qe-workspace/known_hosts) and connect again.';
  }
  if (code === 'HOST_KEY_UNKNOWN') {
    return details?.['reason'] === 'trust_on_first_use_disabled'
      ? `The host key${key} is not in your known_hosts, and your organisation does not allow trusting new hosts here.`
      : `The host key${key} is not in your known_hosts and was not trusted.`;
  }
  return messageFor(code);
}

/** A terminal on the user's own machine: long, like a local ssh, but not forever. */
const TERMINAL_IDLE_MS = 2 * 60 * 60_000;
const TERMINAL_MAX_MS = 12 * 60 * 60_000;
const STREAM_ID = /^[0-9a-f-]{36}$/;

const failure = (error: unknown): ErrorCode => (isDomainError(error) ? error.code : 'INTERNAL_ERROR');

/**
 * The embedded broker for one IDE window (09_LOCAL_AND_WEB_PARITY §3.4): personal targets from the user's SSH
 * configuration, their agent and key files, their `known_hosts`, the organisation's deny list. Terminals reuse the
 * hosted broker's `TerminalBridge` and `qews.v1` frames; file operations reuse the same `RemoteFileSystem`, rooted at
 * the remote home directory. Keys and passphrases stay in this process for the connection only.
 */
export class EmbeddedBroker implements EmbeddedBrokerService {
  protected client: EmbeddedBrokerClient | undefined;
  protected readonly streams = new Map<string, TerminalBridge>();
  /** Host keys the user trusted for this window ("trust once"), by `host:port`. */
  protected readonly trustedOnce = new Map<string, PresentedKey[]>();
  protected readonly hostKeyQuestions = new Map<string, Promise<HostKeyAnswer>>();
  protected readonly files = new Map<
    string,
    Promise<{ fs: RemoteFileSystem; touch(): void; close(): void }>
  >();

  constructor(protected readonly deps: EmbeddedBrokerDeps) {}

  setClient(client: EmbeddedBrokerClient | undefined): void {
    this.client = client;
  }

  getClient(): EmbeddedBrokerClient | undefined {
    return this.client;
  }

  /** The window went away: end its terminals and file connections. */
  dispose(): void {
    for (const bridge of [...this.streams.values()]) bridge.close('client_closed');
    for (const entry of this.files.values()) {
      entry.then(
        (f) => {
          f.close();
        },
        () => undefined,
      );
    }
    this.files.clear();
  }

  async listTargets(): Promise<{ targets: PersonalTargetSummary[]; problems: string[] }> {
    const [targets, problems] = await Promise.all([this.deps.targets.list(), this.deps.targets.problems()]);
    return {
      targets: targets.map((t) => ({
        id: t.id,
        name: t.alias,
        host: t.host,
        port: t.port,
        user: t.user,
        viaJumpHost: t.proxyJump !== undefined,
      })),
      problems,
    };
  }

  /**
   * Connects to a personal target: the organisation's deny list, then the host key against `known_hosts` (a revoked
   * key fails even where trusted, a different key is a hard error), then the agent and plain key files; only if those
   * are rejected, the passphrases of encrypted key files are asked for. A host with no known key is offered to the
   * user once (trust once / trust and save / cancel), between attempts — never on the handshake's timer — and the
   * retry trusts exactly the fingerprint the user saw. The first attempt always runs, with no credentials at all if
   * none are usable without a passphrase, so host-key problems surface before the user is asked for anything.
   */
  protected async connect(
    target: PersonalTarget,
  ): Promise<{ connection: SshConnection; hostKey: PresentedKey }> {
    const { deps } = this;
    if (target.proxyJump !== undefined)
      throw new DomainError('TARGET_NOT_ALLOWED', 'jump hosts arrive in Phase 19');
    const address = await checkPersonalHost(target.host, deps.deniedCidrs, deps.resolver);
    if (!address.allowed) throw new DomainError('TARGET_ADDRESS_FORBIDDEN');
    const credentials = await personalCredentials(target, {
      home: deps.home,
      agent: deps.agent,
      askPassphrase: (keyFile) =>
        this.client?.askPassphrase(target.alias, basename(keyFile)) ?? Promise.resolve(undefined),
      ...(deps.readKey !== undefined && { read: deps.readKey }),
    });
    let unlocked: Promise<SshCredential | undefined> | undefined;
    const unlock = () => (unlocked ??= credentials.unlock());
    const endpoint = { address: address.address, port: target.port, username: target.user };

    const authenticate = async () => {
      const record = await deps.hostKeys.lookup(target.host, target.port);
      const trusted = [...record.trusted, ...(this.trustedOnce.get(hostKeyName(target)) ?? [])];
      const verifier = createHostKeyVerifier(trusted, { revoked: record.revoked });
      const attempt = async (credential: SshCredential) => {
        try {
          const connection = await deps.transport.connect(endpoint, credential, verifier);
          return {
            connection,
            hostKey: verifier.presented ?? { algorithm: 'unknown', fingerprintSha256: '' },
          };
        } catch (error) {
          const code = mapSshError(error, verifier.outcome);
          throw new DomainError(code, 'connect failed', {
            ...(verifier.presented !== undefined &&
              code.startsWith('HOST_KEY_') && {
                details: { presented: verifier.presented, revoked: verifier.outcome === 'revoked' },
              }),
            cause: verifier.presentedKey,
          });
        }
      };
      try {
        return await attempt(credentials.first ?? { kind: 'methods', keys: [] });
      } catch (error) {
        if (failure(error) !== 'CREDENTIALS_REJECTED') throw error;
        if (credentials.encryptedKeys.length === 0) {
          throw credentials.first === undefined ? new DomainError('CREDENTIALS_UNAVAILABLE') : error;
        }
      }
      const second = await unlock();
      if (second === undefined) {
        throw new DomainError(
          credentials.first === undefined ? 'CREDENTIALS_UNAVAILABLE' : 'CREDENTIALS_REJECTED',
        );
      }
      return attempt(second);
    };

    try {
      return await authenticate();
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'HOST_KEY_UNKNOWN') throw error;
      const presented = error.details?.['presented'] as PresentedKey | undefined;
      const blob = error.cause instanceof Uint8Array ? error.cause : undefined;
      if (presented === undefined || blob === undefined) throw error;
      if (!(deps.trustOnFirstUse ?? true)) {
        throw new DomainError('HOST_KEY_UNKNOWN', 'trust on first use is disabled', {
          details: { presented, reason: 'trust_on_first_use_disabled' },
        });
      }
      const answer = await this.askHostKey(target, presented);
      if (answer === 'cancel') {
        throw new DomainError('HOST_KEY_UNKNOWN', 'not trusted', {
          details: { presented, reason: 'not_trusted' },
        });
      }
      if (answer === 'save') await deps.hostKeys.trust(target.host, target.port, blob);
      const name = hostKeyName(target);
      this.trustedOnce.set(name, [...(this.trustedOnce.get(name) ?? []), presented]);
      await deps.audit.record({
        action: 'SSH_HOST_KEY_TRUSTED',
        target: target.id,
        outcome: 'success',
        detail: { fingerprint: presented.fingerprintSha256, saved: answer === 'save' },
      });
      // The retry trusts exactly this fingerprint: a host presenting another key now is a mismatch.
      return authenticate();
    }
  }

  /** One question per host and key at a time: connects that wait on the same answer share it. */
  protected askHostKey(target: PersonalTarget, presented: PresentedKey): Promise<HostKeyAnswer> {
    const key = `${hostKeyName(target)} ${presented.fingerprintSha256}`;
    let pending = this.hostKeyQuestions.get(key);
    if (pending === undefined) {
      pending = (
        this.client?.confirmHostKey({
          targetName: target.alias,
          host: target.host,
          port: target.port,
          ...presented,
        }) ?? Promise.resolve<HostKeyAnswer>('cancel')
      ).finally(() => this.hostKeyQuestions.delete(key));
      this.hostKeyQuestions.set(key, pending);
    }
    return pending;
  }

  async openTerminal(
    streamId: string,
    targetId: string,
    size: { cols: number; rows: number },
  ): Promise<EmbeddedResult<string>> {
    if (!STREAM_ID.test(streamId) || this.streams.has(streamId))
      return { ok: false, code: 'INVALID_REQUEST' };
    const target = await this.deps.targets.get(targetId);
    if (target === undefined) return { ok: false, code: 'NOT_FOUND' };
    const cols = Math.min(1000, Math.max(1, Math.trunc(size.cols)));
    const rows = Math.min(500, Math.max(1, Math.trunc(size.rows)));

    const bridge = new TerminalBridge(
      {
        send: (data) => {
          this.client?.onFrame(streamId, data);
        },
        close: (code, reason) => {
          this.client?.onClosed(streamId, code, reason ?? '');
        },
        bufferedAmount: 0,
      },
      { idleMs: TERMINAL_IDLE_MS, expiresAt: new Date(Date.now() + TERMINAL_MAX_MS) },
    );
    this.streams.set(streamId, bridge);
    bridge.onClosed(() => this.streams.delete(streamId));
    bridge.sendControl({ t: 'status', state: 'CONNECTING' });

    void (async () => {
      try {
        const { connection, hostKey } = await this.connect(target);
        bridge.onClosed((result) => {
          connection.close();
          void this.deps.audit.record({
            action: 'SSH_SESSION_CLOSED',
            target: target.id,
            outcome: 'success',
            detail: { reason: result.reason },
          });
        });
        if (bridge.isClosed) return;
        bridge.sendControl({ t: 'hostkey', ...hostKey, verified: true });
        const pty = await connection.shell({ cols, rows, term: 'xterm-256color' });
        bridge.attach(pty);
        bridge.sendControl({ t: 'status', state: 'ACTIVE' });
        await this.deps.audit.record({ action: 'SSH_SESSION_OPENED', target: target.id, outcome: 'success' });
      } catch (error) {
        const code = failure(error);
        await this.deps.audit.record({
          action: 'SSH_CONNECT_FAILED',
          target: target.id,
          outcome: 'failure',
          detail: { code },
        });
        bridge.sendControl({ t: 'error', code, message: personalMessage(error) });
        bridge.close('connect_failed', code);
      }
    })();
    return { ok: true, value: streamId };
  }

  send(streamId: string, frame: string | Uint8Array): Promise<void> {
    const bridge = this.streams.get(streamId);
    if (bridge !== undefined) {
      if (typeof frame === 'string') bridge.handleMessage(frame, false);
      else bridge.handleMessage(Buffer.from(frame), true);
    }
    return Promise.resolve();
  }

  closeTerminal(streamId: string): Promise<void> {
    this.streams.get(streamId)?.close('client_closed');
    return Promise.resolve();
  }

  /** The target's file connection: opened on first use, rooted at the remote home, closed after a while unused. */
  protected fileSystem(target: PersonalTarget) {
    let entry = this.files.get(target.id);
    if (entry === undefined) {
      const idleMs = this.deps.filesIdleMs ?? 10 * 60_000;
      entry = (async () => {
        const { connection } = await this.connect(target);
        const sftp = await connection.sftp().catch((error: unknown) => {
          connection.close();
          throw error;
        });
        const remoteRoot = await sftp.realpath('.');
        let timer: NodeJS.Timeout | undefined;
        const close = () => {
          clearTimeout(timer);
          this.files.delete(target.id);
          sftp.close();
          connection.close();
        };
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(close, idleMs);
        };
        connection.onClose(() => this.files.delete(target.id));
        touch();
        return { fs: createRemoteFileSystem(sftp, { remoteRoot, canWrite: true }), touch, close };
      })();
      this.files.set(target.id, entry);
      entry.catch(() => this.files.delete(target.id));
    }
    return entry;
  }

  async fs(targetId: string, op: FsOp, request: unknown): Promise<EmbeddedResult<unknown>> {
    try {
      const target = await this.deps.targets.get(targetId);
      if (target === undefined) return { ok: false, code: 'NOT_FOUND' };
      const work = fileOperation(op, request);
      const files = await this.fileSystem(target);
      files.touch();
      const value = await work(files.fs);
      if (op === 'write' || op === 'mkdir' || op === 'rename' || op === 'delete') {
        await this.deps.audit.record({
          action: 'REMOTE_FILE_CHANGE',
          target: target.id,
          outcome: 'success',
          detail: { op },
        });
      }
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        code: isDomainError(error)
          ? error.code
          : error instanceof Error && error.name === 'ZodError'
            ? 'INVALID_REQUEST'
            : 'INTERNAL_ERROR',
      };
    }
  }
}
