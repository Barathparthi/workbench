import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local web mode's access check (PHASE_10 §10.6, 09_LOCAL_AND_WEB_PARITY §5): the IDE on 127.0.0.1 can still be
 * reached by other local users and processes, and by any web page through DNS rebinding — so nothing is served
 * without the cookie that only the sign-in link gives. The link carries a token generated per run (or handed over by
 * the launcher); opening it sets an HttpOnly, SameSite=Strict cookie and redirects to the same address without it.
 */
export const LOCAL_WEB_TOKEN_ENV = 'QE_LOCAL_WEB_TOKEN';
/** Set by the local-web container: it listens on all of the container's interfaces, published on 127.0.0.1 only. */
export const LOCAL_WEB_CONTAINER_ENV = 'QE_LOCAL_WEB_CONTAINER';
export const LOCAL_WEB_COOKIE = 'qe_local';

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface LocalWebSecret {
  readonly token: string;
  /** Whether the launcher handed it over (it shows the link) or it was generated here (written to a private file). */
  readonly provided: boolean;
}

/**
 * The run's token: from the launcher (QE_LOCAL_WEB_TOKEN), or generated. The variable is removed from the
 * environment at once, so terminals and tasks started by the IDE never inherit it.
 */
export function takeLocalWebSecret(env: NodeJS.ProcessEnv = process.env): LocalWebSecret {
  const provided = env[LOCAL_WEB_TOKEN_ENV];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the variable must not outlive this read
  delete env[LOCAL_WEB_TOKEN_ENV];
  if (provided !== undefined) {
    if (!TOKEN.test(provided)) {
      throw new Error(`${LOCAL_WEB_TOKEN_ENV} must be 32 to 128 characters of [A-Za-z0-9_-]`);
    }
    return { token: provided, provided: true };
  }
  return { token: randomBytes(32).toString('base64url'), provided: false };
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** The cookie's value: derived from the token, so a restarted backend with the launcher's token keeps the browser in. */
export const localWebCookieValue = (token: string): string =>
  createHmac('sha256', token).update('qe-local-web-session').digest('base64url');

function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Host header names this machine's loopback: anything else is a rebound name or another interface. */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

export type LocalWebDecision =
  | { readonly kind: 'allow' }
  /** The sign-in link: set the cookie and go to `location` (the same address without the token). */
  | { readonly kind: 'sign-in'; readonly location: string; readonly cookie: string }
  | { readonly kind: 'refuse'; readonly status: 401 | 403 };

/** What a request may do, from its method, URL, Host and Cookie headers. */
export function decide(
  secret: LocalWebSecret,
  request: { method?: string | undefined; url?: string | undefined; headers: IncomingMessage['headers'] },
): LocalWebDecision {
  if (!isLoopbackHost(request.headers.host)) return { kind: 'refuse', status: 403 };
  const cookie = cookieOf(request.headers.cookie, LOCAL_WEB_COOKIE);
  const expected = localWebCookieValue(secret.token);
  if (cookie !== undefined && same(cookie, expected)) return { kind: 'allow' };

  const url = new URL(request.url ?? '/', 'http://local');
  const token = url.searchParams.get('token');
  if (request.method === 'GET' && token !== null && same(token, secret.token)) {
    url.searchParams.delete('token');
    return {
      kind: 'sign-in',
      location: `${url.pathname}${url.search}`,
      cookie: `${LOCAL_WEB_COOKIE}=${expected}; Path=/; HttpOnly; SameSite=Strict`,
    };
  }
  return { kind: 'refuse', status: 401 };
}

const REFUSED_PAGE = (status: 401 | 403) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>QE Workspace</title></head><body><p>${
    status === 403
      ? 'This QE Workspace answers on 127.0.0.1 only.'
      : 'This QE Workspace runs on your machine and opens with its sign-in link: use the address qe-workspace-local printed (with its token).'
  }</p></body></html>`;

/** Express-compatible middleware, run before Theia serves anything. */
export function localWebMiddleware(secret: LocalWebSecret) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const decision = decide(secret, req);
    switch (decision.kind) {
      case 'allow':
        next();
        return;
      case 'sign-in':
        res
          .writeHead(303, {
            location: decision.location,
            'set-cookie': decision.cookie,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          .end();
        return;
      case 'refuse':
        res
          .writeHead(decision.status, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'",
          })
          .end(REFUSED_PAGE(decision.status));
        return;
    }
  };
}

/** WebSocket (and Socket.IO polling) handshakes: the cookie and a loopback Host, never the token. */
export function allowsLocalWebUpgrade(secret: LocalWebSecret, request: IncomingMessage): boolean {
  if (!isLoopbackHost(request.headers.host)) return false;
  const cookie = cookieOf(request.headers.cookie, LOCAL_WEB_COOKIE);
  return cookie !== undefined && same(cookie, localWebCookieValue(secret.token));
}

/**
 * Local web listens on loopback only (PHASE_10 §10.6). In the local-web container it listens on the container's
 * interfaces and the container is published on the host's 127.0.0.1 (docker-compose.local-web.yml).
 */
export function listeningProblem(
  address: AddressInfo | string | null,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (address === null || typeof address === 'string') return undefined; // a Unix socket or pipe: local by nature
  const loopback =
    address.address === '127.0.0.1' || address.address === '::1' || address.address.startsWith('127.');
  if (loopback || env[LOCAL_WEB_CONTAINER_ENV] === '1') return undefined;
  return `local web mode listens on 127.0.0.1 only, not ${address.address} (start it with --hostname=127.0.0.1)`;
}

/** A generated token's sign-in link goes to a private file, never to a log. */
export async function writeSignInLink(url: string, home: string = homedir()): Promise<string> {
  const dir = join(home, '.qe-workspace');
  const file = join(dir, 'local-web-url');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${url}\n`, { mode: 0o600 });
  await chmod(file, 0o600); // an existing file keeps its mode on write
  return file;
}
