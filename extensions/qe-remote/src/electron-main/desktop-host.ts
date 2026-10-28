import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DESKTOP_HOST_LIMITS,
  isOpenableUrl,
  type DesktopHostAddress,
  type DesktopHostError,
  type DesktopHostRequest,
  type DesktopHostResponse,
} from '../common/desktop-host-protocol';

/** Electron's `safeStorage`, behind an interface (a fake in tests). */
export interface StringCipher {
  /** Whether real encryption is available (not Linux's `basic_text` fallback, which is plain text in effect). */
  readonly available: boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export class HostError extends Error {
  constructor(readonly code: DesktopHostError) {
    super(code);
  }
}

/**
 * Secrets as files of ciphertext under `dir` (one per key, named by the key's hash; directory 0700, files 0600). With
 * no real encryption available nothing is written and `set` fails with `unavailable`: never plain text on disk.
 */
export function secretFileStore(dir: string, cipher: () => Promise<StringCipher>) {
  const file = (key: string) => join(dir, `${createHash('sha256').update(key).digest('hex')}.bin`);
  return {
    async get(key: string): Promise<string | null> {
      let data: Buffer;
      try {
        data = await readFile(file(key));
      } catch {
        return null;
      }
      const c = await cipher();
      if (!c.available) throw new HostError('unavailable');
      try {
        return c.decrypt(data);
      } catch {
        // Written under another OS account or keychain: unusable, so gone.
        await rm(file(key), { force: true });
        return null;
      }
    },
    async set(key: string, value: string): Promise<void> {
      const c = await cipher();
      if (!c.available) throw new HostError('unavailable');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = file(key);
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temp, c.encrypt(value), { mode: 0o600 });
      await rename(temp, target);
    },
    async delete(key: string): Promise<void> {
      await rm(file(key), { force: true });
    },
  };
}
export type SecretStore = ReturnType<typeof secretFileStore>;

export interface DesktopHostOptions {
  readonly secrets: SecretStore;
  openExternal(url: string): Promise<void>;
  /** Defaults to this process's platform: a named pipe on Windows, a Unix socket in a private directory elsewhere. */
  readonly platform?: NodeJS.Platform;
}

export interface DesktopHost extends DesktopHostAddress {
  close(): Promise<void>;
}

const isKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length > 0 && key.length <= DESKTOP_HOST_LIMITS.maxKeyLength;

async function handle(
  request: DesktopHostRequest,
  options: DesktopHostOptions,
): Promise<string | null | undefined> {
  switch (request.op) {
    case 'openExternal':
      if (typeof request.url !== 'string' || !isOpenableUrl(request.url)) throw new HostError('refused');
      await options.openExternal(request.url);
      return undefined;
    case 'secret.get':
      if (!isKey(request.key)) throw new HostError('refused');
      return options.secrets.get(request.key);
    case 'secret.set':
      if (
        !isKey(request.key) ||
        typeof request.value !== 'string' ||
        request.value.length > DESKTOP_HOST_LIMITS.maxValueLength
      ) {
        throw new HostError('refused');
      }
      await options.secrets.set(request.key, request.value);
      return undefined;
    case 'secret.delete':
      if (!isKey(request.key)) throw new HostError('refused');
      await options.secrets.delete(request.key);
      return undefined;
    default:
      throw new HostError('refused');
  }
}

/** Serves one connection: the token first (or the connection is dropped without a word), then requests. */
function serve(socket: Socket, expected: Buffer, options: DesktopHostOptions): void {
  let buffered = '';
  let authenticated = false;
  socket.setEncoding('utf8');
  const reply = (response: DesktopHostResponse) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  };
  socket.on('error', () => undefined);
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    if (buffered.length > DESKTOP_HOST_LIMITS.maxLineBytes) {
      socket.destroy();
      return;
    }
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (!authenticated) {
        const token = (message as { token?: unknown } | null)?.token;
        const presented = Buffer.from(typeof token === 'string' ? token : '');
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
          socket.destroy();
          return;
        }
        authenticated = true;
        continue;
      }
      const request = message as DesktopHostRequest;
      if (typeof request.id !== 'number') {
        socket.destroy();
        return;
      }
      handle(request, options).then(
        (value) => {
          reply(value === undefined ? { id: request.id, ok: true } : { id: request.id, ok: true, value });
        },
        (error: unknown) => {
          reply({ id: request.id, ok: false, error: error instanceof HostError ? error.code : 'failed' });
        },
      );
    }
  });
}

/** Starts main's side of the channel; its address and token go to the backend only (desktop-host-protocol.ts). */
export async function startDesktopHost(options: DesktopHostOptions): Promise<DesktopHost> {
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(token);
  const windows = (options.platform ?? process.platform) === 'win32';
  // A socket in a fresh 0700 directory: no other local user can even reach it. Named pipes are per machine; the
  // random name and the token keep others out.
  const socketDir = windows ? undefined : mkdtempSync(join(tmpdir(), 'qe-host-'));
  const address = windows
    ? `\\\\.\\pipe\\qe-desktop-host-${randomBytes(16).toString('hex')}`
    : join(socketDir ?? '', 'host.sock');

  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    serve(socket, expected, options);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    address,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (socketDir !== undefined) rmSync(socketDir, { recursive: true, force: true });
          resolve();
        });
        // The backend keeps its connection open; closing the host ends it.
        for (const socket of connections) socket.destroy();
      }),
  };
}
