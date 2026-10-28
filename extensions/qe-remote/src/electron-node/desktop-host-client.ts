import { connect, type Socket } from 'node:net';

import {
  DESKTOP_HOST_ENV,
  DESKTOP_HOST_LIMITS,
  type DesktopHostAddress,
  type DesktopHostError,
  type DesktopHostRequest,
  type DesktopHostResponse,
} from '../common/desktop-host-protocol';

/** What the backend asks of Electron's main process. */
export interface DesktopHostClient {
  openExternal(url: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  /** Rejects with `DesktopHostFailure('unavailable')` when the OS cannot encrypt it: nothing is stored then. */
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export class DesktopHostFailure extends Error {
  constructor(readonly code: DesktopHostError | 'timeout' | 'disconnected') {
    super(`desktop host: ${code}`);
    this.name = 'DesktopHostFailure';
  }
}

/**
 * Takes the channel's address out of the environment, once: later reads (and every process the backend starts, such
 * as terminals) no longer see it. `undefined` when the backend was not started by the desktop app's main process.
 */
export function takeDesktopHostAddress(env: NodeJS.ProcessEnv = process.env): DesktopHostAddress | undefined {
  const raw = env[DESKTOP_HOST_ENV];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the variable must not outlive this read
  delete env[DESKTOP_HOST_ENV];
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DesktopHostAddress>;
    return typeof parsed.address === 'string' && typeof parsed.token === 'string'
      ? { address: parsed.address, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

const TIMEOUT_MS = 10_000;

/** A request before it gets its id (distributes over the union, keeping each op's fields). */
type Unnumbered<T> = T extends unknown ? Omit<T, 'id'> : never;
type Pending = {
  resolve: (r: DesktopHostResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

/** A client that connects on first use and again after the connection drops. */
export function desktopHostClient(target: DesktopHostAddress, timeoutMs = TIMEOUT_MS): DesktopHostClient {
  let socket: Socket | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (error: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  const open = (): Socket => {
    if (socket !== undefined && !socket.destroyed) return socket;
    const s = connect(target.address);
    s.setEncoding('utf8');
    s.write(`${JSON.stringify({ token: target.token })}\n`);
    let buffered = '';
    s.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.length > DESKTOP_HOST_LIMITS.maxLineBytes) {
        s.destroy();
        return;
      }
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        try {
          const response = JSON.parse(line) as DesktopHostResponse;
          const p = pending.get(response.id);
          if (p === undefined) continue;
          pending.delete(response.id);
          clearTimeout(p.timer);
          p.resolve(response);
        } catch {
          s.destroy();
        }
      }
    });
    s.on('error', () => undefined);
    s.on('close', () => {
      if (socket === s) socket = undefined;
      failAll(new DesktopHostFailure('disconnected'));
    });
    socket = s;
    return s;
  };

  const call = (request: Unnumbered<DesktopHostRequest>): Promise<string | null | undefined> =>
    new Promise<DesktopHostResponse>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new DesktopHostFailure('timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      open().write(`${JSON.stringify({ ...request, id })}\n`);
    }).then((response) => {
      if (!response.ok) throw new DesktopHostFailure(response.error);
      return response.value;
    });

  return {
    openExternal: async (url) => {
      await call({ op: 'openExternal', url });
    },
    getSecret: async (key) => (await call({ op: 'secret.get', key })) ?? null,
    setSecret: async (key, value) => {
      await call({ op: 'secret.set', key, value });
    },
    deleteSecret: async (key) => {
      await call({ op: 'secret.delete', key });
    },
  };
}
