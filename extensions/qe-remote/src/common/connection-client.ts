import type { FsOp } from '@qe/contracts';

import type { EmbeddedBrokerClient, EmbeddedBrokerService } from './embedded-broker-protocol';
import { RemoteApiError, streamTarget, type RemoteClient } from './remote-client';
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

export interface ConnectionClient extends FileCaller {
  /** Every reachable system; a part that fails is reported in `problems` while the others are still listed. */
  listTargets(): Promise<{ targets: RemoteTarget[]; problems: string[] }>;
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
}): ConnectionClient {
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
      const session = await deps.client.openTerminalSession(target.id, size);
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
    },
    call: (targetId, op, body) => deps.files.call(targetId, op, body),
  };
}

/**
 * Personal targets through the embedded broker (desktop, local web). The backend calls `client` back with frames,
 * closes and passphrase questions; streams get an id chosen here, so their sink exists before the first frame.
 */
export class EmbeddedConnection implements ConnectionClient {
  protected readonly sinks = new Map<string, TerminalSink>();
  protected askPassphrase: (targetName: string, keyFile: string) => Promise<string | undefined> = () =>
    Promise.resolve(undefined);

  /** What the backend calls: hand this to the RPC proxy as its client. */
  readonly client: EmbeddedBrokerClient = {
    onFrame: (streamId, frame) => {
      this.sinks.get(streamId)?.frame(frame);
    },
    onClosed: (streamId, code) => {
      this.sinks.get(streamId)?.closed(code);
      this.sinks.delete(streamId);
    },
    askPassphrase: (targetName, keyFile) => this.askPassphrase(targetName, keyFile),
  };

  constructor(
    protected readonly service: () => EmbeddedBrokerService,
    protected readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** The IDE's input dialog (set by the UI once it exists); without it, passphrases are never asked. */
  setPassphraseAsker(ask: (targetName: string, keyFile: string) => Promise<string | undefined>): void {
    this.askPassphrase = ask;
  }

  async listTargets() {
    const { targets, problems } = await this.service().listTargets();
    return {
      targets: targets.map((t) => ({
        id: t.id,
        name: t.name,
        description: `${t.user}@${t.host}${t.port === 22 ? '' : `:${String(t.port)}`}`,
        detail: t.viaJumpHost
          ? 'from your SSH configuration — via a jump host, not supported yet'
          : 'from your SSH configuration',
        kind: 'personal' as const,
      })),
      problems,
    };
  }

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

  async call<T>(targetId: string, op: FsOp, body: object): Promise<T> {
    const result = await this.service().fs(targetId, op, body);
    if (!result.ok) throw new RemoteApiError(0, result.code);
    return result.value as T;
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
      let firstError: unknown;
      for (const r of results) {
        if (r.status === 'fulfilled') {
          targets.push(...r.value.targets);
          problems.push(...r.value.problems);
        } else firstError ??= r.reason;
      }
      // Every part failed: that is an error, not an empty list.
      if (firstError !== undefined && targets.length === 0 && results.every((r) => r.status === 'rejected')) {
        throw firstError instanceof Error ? firstError : new Error('the remote systems could not be listed');
      }
      if (firstError !== undefined) problems.push('Some remote systems could not be listed.');
      return { targets, problems };
    },
    // async: a target no part owns rejects like any other failure, never throws synchronously.
    openTerminal: async (target, size, sink) => owner(target.id).openTerminal(target, size, sink),
    call: async (targetId, op, body) => owner(targetId).call(targetId, op, body),
  };
}
