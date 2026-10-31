import type { FsOp } from '@qe/contracts';
import type { RemoteTestRequest } from '@qe/theia-qe-core/lib/common/qe-remote-tests';

import type {
  EmbeddedBrokerClient,
  EmbeddedBrokerService,
  EmbeddedResult,
  HostKeyAnswer,
  HostKeyQuestion,
  NewHostRequest,
  PersonalTargetSummary,
} from './embedded-broker-protocol';
import { SIGN_IN_REQUIRED, type ManagedRelayService, type StreamClient } from './managed-relay-protocol';
import {
  describeFailure,
  RemoteApiError,
  streamTarget,
  type OpenedSession,
  type RemoteClient,
} from './remote-client';
import type { RemoteFileSessions } from './remote-files';

/**
 * One way to reach remote systems, whatever the mode (09_LOCAL_AND_WEB_PARITY §3.1): managed targets through the
 * control plane and hosted broker, personal targets through the embedded broker in the IDE backend. The terminal
 * adapter and the `qe-ssh` file system use this interface only, so they behave the same in every mode.
 */
export interface RemoteTarget {
  readonly id: string;
  readonly name: string;
  /** Shown next to the name: the host, or `user@host:port` for a personal target. */
  readonly description: string;
  readonly detail: string;
  readonly kind: 'managed' | 'personal';
}

/** Receives a terminal's `qews.v1` frames and its close code. */
export interface TerminalSink {
  frame(frame: string | Uint8Array): void;
  closed(code: number): void;
}

export interface TerminalStream {
  send(frame: string | Uint8Array): void;
  close(): void;
}

export interface FileCaller {
  call<T>(targetId: string, op: FsOp, body: object): Promise<T>;
}

/**
 * `problems`: entries that cannot be used (a broken SSH config entry, a part that failed). `notices`: what the user
 * can do to see more (sign in to QE Workspace) — information, not an error.
 */
export interface TargetListing {
  readonly targets: RemoteTarget[];
  readonly problems: string[];
  readonly notices?: string[];
}

export interface ConnectionClient extends FileCaller {
  /** Every reachable system; a part that fails is reported in `problems` while the others are still listed. */
  listTargets(): Promise<TargetListing>;
  /**
   * Runs tests in the target's folder (PHASE_11 §11.4), streamed like a terminal: output frames, a `run` result, the
   * close. Failures before the stream exists reject with a `RemoteApiError`.
   */
  runTests(
    target: RemoteTarget,
    request: RemoteTestRequest,
    sink: TerminalSink,
  ): Promise<{ runId: string; stream: TerminalStream }>;
  /** Opens a terminal; failures before the stream exists reject with a `RemoteApiError`. */
  openTerminal(
    target: RemoteTarget,
    size: { cols: number; rows: number },
    sink: TerminalSink,
  ): Promise<TerminalStream>;
}

const PERSONAL_PREFIX = 'personal-';
export const isPersonalTarget = (targetId: string): boolean => targetId.startsWith(PERSONAL_PREFIX);

/** Managed targets: REST to the control plane, the broker's WebSocket stream, files-sessions (Phases 07–09). */
export function hostedConnectionClient(deps: {
  readonly client: RemoteClient;
  readonly files: RemoteFileSessions;
  readonly origin: string;
  readonly createSocket: (url: string, protocols: string[]) => WebSocket;
  /** Hosted: the workspace a test run belongs to (its members then see it). */
  readonly workspaceId?: string;
}): ConnectionClient {
  /** A broker stream for an opened session: frames to the sink, sends queued until the socket opens. */
  const stream = (session: OpenedSession, sink: TerminalSink): TerminalStream => {
    const { url, protocols } = streamTarget(deps.origin, session);
    const socket = deps.createSocket(url, protocols);
    socket.binaryType = 'arraybuffer';
    const queued: (string | Uint8Array)[] = [];
    socket.onopen = () => {
      for (const frame of queued.splice(0)) socket.send(frame);
    };
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      sink.frame(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
    };
    socket.onclose = (event) => {
      sink.closed(event.code);
    };
    return {
      send: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(frame);
        else if (socket.readyState === socket.CONNECTING) queued.push(frame);
      },
      close: () => {
        socket.close(1000);
      },
    };
  };
  return {
    async listTargets() {
      const targets = await deps.client.listTargets();
      return {
        targets: targets.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.host,
          detail: [t.os, ...t.tags].join(' · ') + (t.description === null ? '' : ` — ${t.description}`),
          kind: 'managed' as const,
        })),
        problems: [],
      };
    },
    async openTerminal(target, size, sink) {
      return stream(await deps.client.openTerminalSession(target.id, size), sink);
    },
    async runTests(target, request, sink) {
      const started = await deps.client.startTestRun(target.id, request, deps.workspaceId);
      return { runId: started.runId, stream: stream(started.session, sink) };
    },
    call: (targetId, op, body) => deps.files.call(targetId, op, body),
  };
}

/** What a backend that streams terminals over RPC offers (the embedded broker, the desktop managed relay). */
interface StreamService {
  openTerminal(
    streamId: string,
    targetId: string,
    size: { cols: number; rows: number },
  ): Promise<EmbeddedResult<string>>;
  send(streamId: string, frame: string | Uint8Array): Promise<void>;
  closeTerminal(streamId: string): Promise<void>;
  fs(targetId: string, op: FsOp, request: unknown): Promise<EmbeddedResult<unknown>>;
  runTests(streamId: string, targetId: string, request: RemoteTestRequest): Promise<EmbeddedResult<string>>;
}

/**
 * Terminals and files through a backend service over Theia's RPC channel. Streams get an id chosen here, so their
 * sink exists before the backend sends the first frame; the backend calls `streams` back with frames and closes.
 */
abstract class StreamedConnection<S extends StreamService> implements ConnectionClient {
  protected readonly sinks = new Map<string, TerminalSink>();

  protected readonly streams: StreamClient = {
    onFrame: (streamId, frame) => {
      this.sinks.get(streamId)?.frame(frame);
    },
    onClosed: (streamId, code) => {
      this.sinks.get(streamId)?.closed(code);
      this.sinks.delete(streamId);
    },
  };

  constructor(
    protected readonly service: () => S,
    protected readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  abstract listTargets(): Promise<TargetListing>;

  async openTerminal(target: RemoteTarget, size: { cols: number; rows: number }, sink: TerminalSink) {
    const service = this.service();
    const streamId = this.newId();
    this.sinks.set(streamId, sink);
    const result = await service.openTerminal(streamId, target.id, size);
    if (!result.ok) {
      this.sinks.delete(streamId);
      throw new RemoteApiError(0, result.code);
    }
    return {
      send: (frame: string | Uint8Array) => {
        void service.send(streamId, frame);
      },
      close: () => {
        void service.closeTerminal(streamId);
      },
    };
  }

  async runTests(target: RemoteTarget, request: RemoteTestRequest, sink: TerminalSink) {
    const service = this.service();
    const streamId = this.newId();
    this.sinks.set(streamId, sink);
    const result = await service.runTests(streamId, target.id, request);
    if (!result.ok) {
      this.sinks.delete(streamId);
      throw new RemoteApiError(0, result.code);
    }
    return {
      runId: result.value,
      stream: {
        send: (frame: string | Uint8Array) => {
          void service.send(streamId, frame);
        },
        close: () => {
          void service.closeTerminal(streamId);
        },
      },
    };
  }

  async call<T>(targetId: string, op: FsOp, body: object): Promise<T> {
    const result = await this.service().fs(targetId, op, body);
    if (!result.ok) throw new RemoteApiError(0, result.code);
    return result.value as T;
  }
}

/**
 * Personal targets through the embedded broker (desktop, local web). Besides frames and closes, the backend asks the
 * user for passphrases and about unknown host keys through `client`.
 */
export class EmbeddedConnection extends StreamedConnection<EmbeddedBrokerService> {
  protected askPassphrase: (targetName: string, keyFile: string) => Promise<string | undefined> = () =>
    Promise.resolve(undefined);
  protected confirmHostKey: (question: HostKeyQuestion) => Promise<HostKeyAnswer> = () =>
    Promise.resolve('cancel');

  /** What the backend calls: hand this to the RPC proxy as its client. */
  readonly client: EmbeddedBrokerClient = {
    ...this.streams,
    askPassphrase: (targetName, keyFile) => this.askPassphrase(targetName, keyFile),
    confirmHostKey: (question) => this.confirmHostKey(question),
  };

  /** The IDE's host-key dialog (set by the UI); without it, unknown host keys are never trusted. */
  setHostKeyAsker(ask: (question: HostKeyQuestion) => Promise<HostKeyAnswer>): void {
    this.confirmHostKey = ask;
  }

  /** The IDE's input dialog (set by the UI once it exists); without it, passphrases are never asked. */
  setPassphraseAsker(ask: (targetName: string, keyFile: string) => Promise<string | undefined>): void {
    this.askPassphrase = ask;
  }

  async listTargets() {
    const { targets, problems } = await this.service().listTargets();
    return { targets: targets.map(personalTarget), problems };
  }

  /** Adds a host to `~/.qe-workspace/ssh_hosts`; a string is what the user should read when it was not added. */
  async addHost(request: NewHostRequest): Promise<RemoteTarget | string> {
    const result = await this.service().addHost(request);
    if (result.ok) return personalTarget(result.value);
    return result.message ?? describeFailure(new RemoteApiError(0, result.code));
  }
}

function personalTarget(t: PersonalTargetSummary): RemoteTarget {
  return {
    id: t.id,
    name: t.name,
    description: `${t.user}@${t.host}${t.port === 22 ? '' : `:${String(t.port)}`}`,
    detail: t.viaJumpHost
      ? 'from your SSH configuration — via a jump host, not supported yet'
      : 'from your SSH configuration',
    kind: 'personal',
  };
}

/** Shown in the picker while the desktop app is not signed in to its control plane. */
export const SIGN_IN_NOTICE =
  'Sign in to QE Workspace to see your organisation’s systems: run “QE: Sign In to QE Workspace”.';

/** Managed targets in the desktop app, through the backend's relay (managed-relay-protocol.ts). */
export class RelayedConnection extends StreamedConnection<ManagedRelayService> {
  /** What the backend calls: hand this to the RPC proxy as its client. */
  readonly client: StreamClient = this.streams;

  async listTargets(): Promise<TargetListing> {
    const result = await this.service().listTargets();
    if (!result.ok) {
      if (result.code === SIGN_IN_REQUIRED) return { targets: [], problems: [], notices: [SIGN_IN_NOTICE] };
      throw new RemoteApiError(0, result.code);
    }
    return {
      targets: result.value.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.host,
        detail: t.detail,
        kind: 'managed' as const,
      })),
      problems: [],
    };
  }
}

/** Managed and personal targets in one list; each request goes to the part that owns its target. */
export function compositeConnectionClient(parts: {
  readonly managed?: ConnectionClient | undefined;
  readonly personal?: ConnectionClient | undefined;
}): ConnectionClient {
  const owner = (targetId: string): ConnectionClient => {
    const part = isPersonalTarget(targetId) ? parts.personal : parts.managed;
    if (part === undefined) throw new RemoteApiError(404, 'NOT_FOUND');
    return part;
  };
  return {
    async listTargets() {
      const present = [parts.managed, parts.personal].filter((p): p is ConnectionClient => p !== undefined);
      const results = await Promise.allSettled(present.map((p) => p.listTargets()));
      const targets: RemoteTarget[] = [];
      const problems: string[] = [];
      const notices: string[] = [];
      let firstError: unknown;
      for (const r of results) {
        if (r.status === 'fulfilled') {
          targets.push(...r.value.targets);
          problems.push(...r.value.problems);
          notices.push(...(r.value.notices ?? []));
        } else firstError ??= r.reason;
      }
      // Every part failed: that is an error, not an empty list.
      if (firstError !== undefined && targets.length === 0 && results.every((r) => r.status === 'rejected')) {
        throw firstError instanceof Error ? firstError : new Error('the remote systems could not be listed');
      }
      if (firstError !== undefined) problems.push('Some remote systems could not be listed.');
      return notices.length > 0 ? { targets, problems, notices } : { targets, problems };
    },
    // async: a target no part owns rejects like any other failure, never throws synchronously.
    openTerminal: async (target, size, sink) => owner(target.id).openTerminal(target, size, sink),
    runTests: async (target, request, sink) => owner(target.id).runTests(target, request, sink),
    call: async (targetId, op, body) => owner(targetId).call(targetId, op, body),
  };
}
