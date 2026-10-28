import { MAX_MESSAGE_BYTES, type FsOp } from '@qe/contracts';
import { WebSocket as NodeWebSocket } from 'ws';

import {
  hostedConnectionClient,
  isPersonalTarget,
  type ConnectionClient,
  type TerminalStream,
} from '../common/connection-client';
import type { EmbeddedResult } from '../common/embedded-broker-protocol';
import {
  SIGN_IN_REQUIRED,
  type ManagedRelayService,
  type ManagedTargetSummary,
  type StreamClient,
} from '../common/managed-relay-protocol';
import { RemoteApiError, remoteClient } from '../common/remote-client';
import { RemoteFileSessions } from '../common/remote-files';
import { DesktopSignInError } from './desktop-account';

export interface ManagedRelayDeps {
  /** The control plane the desktop app is connected to (QE_CONTROL_PLANE_URL). */
  readonly controlPlaneUrl: string;
  /** The signed-in user's access token; rejects with DesktopSignInError('sign_in_required') when there is none. */
  accessToken(): Promise<string>;
  readonly fetch?: typeof fetch;
  /** Tests: the stream socket. By default `ws`, which sends no Origin header (the broker's desktop path). */
  readonly createSocket?: (url: string, protocols: string[]) => WebSocket;
}

const STREAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Terminals per window; the control plane's per-user session limit applies on top. */
const MAX_STREAMS = 32;

/** API and sign-in failures as the codes the frontend shows; an ended sign-in is SIGN_IN_REQUIRED. */
function codeOf(error: unknown): string {
  if (error instanceof DesktopSignInError) {
    return error.reason === 'sign_in_required' ? SIGN_IN_REQUIRED : 'UNAVAILABLE';
  }
  if (error instanceof RemoteApiError) return error.code === 'AUTH_REQUIRED' ? SIGN_IN_REQUIRED : error.code;
  return 'UNAVAILABLE';
}

async function result<T>(work: () => Promise<T>): Promise<EmbeddedResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
}

/**
 * The desktop app's managed targets (managed-relay-protocol.ts): the hosted connection client, run in the Electron
 * backend with the user's bearer token instead of a browser session. Nothing here keeps a token; each request asks
 * the account for a current one. One relay per window; its terminals end with the window.
 */
export class ManagedRelay implements ManagedRelayService {
  protected client: StreamClient | undefined;
  protected readonly streams = new Map<string, TerminalStream>();
  protected readonly hosted: ConnectionClient;

  constructor(deps: ManagedRelayDeps) {
    const base = deps.controlPlaneUrl.replace(/\/+$/, '');
    const doFetch = deps.fetch ?? fetch;
    // Bearer token, no cookies (so no CSRF token either): the control plane judges the request on the token alone.
    const bearerFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${await deps.accessToken()}`);
      return doFetch(input, { ...init, credentials: 'omit', headers, redirect: 'error' });
    };
    const api = remoteClient({ origin: base, cookies: () => '', fetch: bearerFetch });
    this.hosted = hostedConnectionClient({
      client: api,
      files: new RemoteFileSessions(api),
      origin: base,
      createSocket:
        deps.createSocket ??
        ((url, protocols) => {
          const socket = new NodeWebSocket(url, protocols, { maxPayload: MAX_MESSAGE_BYTES });
          // A refused upgrade is an 'error' event: unheard, it would throw and end the backend. The close that
          // follows reaches the terminal.
          socket.on('error', () => undefined);
          return socket as unknown as WebSocket;
        }),
    });
  }

  setClient(client: StreamClient | undefined): void {
    this.client = client;
  }

  listTargets(): Promise<EmbeddedResult<ManagedTargetSummary[]>> {
    return result(async () =>
      (await this.hosted.listTargets()).targets.map((t) => ({
        id: t.id,
        name: t.name,
        host: t.description,
        detail: t.detail,
      })),
    );
  }

  openTerminal(
    streamId: string,
    targetId: string,
    size: { cols: number; rows: number },
  ): Promise<EmbeddedResult<string>> {
    return result(async () => {
      if (!STREAM_ID.test(streamId) || this.streams.has(streamId) || isPersonalTarget(targetId)) {
        throw new RemoteApiError(400, 'INVALID_REQUEST');
      }
      if (this.streams.size >= MAX_STREAMS) throw new RemoteApiError(429, 'QUOTA_EXCEEDED');
      const stream = await this.hosted.openTerminal(
        { id: targetId, name: '', description: '', detail: '', kind: 'managed' },
        size,
        {
          frame: (frame) => {
            this.client?.onFrame(streamId, frame);
          },
          closed: (code) => {
            this.streams.delete(streamId);
            this.client?.onClosed(streamId, code, '');
          },
        },
      );
      this.streams.set(streamId, stream);
      return streamId;
    });
  }

  send(streamId: string, frame: string | Uint8Array): Promise<void> {
    this.streams.get(streamId)?.send(frame);
    return Promise.resolve();
  }

  closeTerminal(streamId: string): Promise<void> {
    this.streams.get(streamId)?.close();
    return Promise.resolve();
  }

  fs(targetId: string, op: FsOp, request: unknown): Promise<EmbeddedResult<unknown>> {
    return result(async () => {
      if (isPersonalTarget(targetId) || typeof request !== 'object' || request === null) {
        throw new RemoteApiError(400, 'INVALID_REQUEST');
      }
      return this.hosted.call(targetId, op, request);
    });
  }

  /** The window closed: end its terminals (their sessions close on the broker). */
  dispose(): void {
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
    this.client = undefined;
  }
}
