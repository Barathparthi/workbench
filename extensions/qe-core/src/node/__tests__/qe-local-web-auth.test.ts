import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  allowsLocalWebUpgrade,
  decide,
  isLoopbackHost,
  listeningProblem,
  LOCAL_WEB_CONTAINER_ENV,
  LOCAL_WEB_TOKEN_ENV,
  localWebCookieValue,
  localWebMiddleware,
  takeLocalWebSecret,
  writeSignInLink,
} from '../qe-local-web-auth';

const TOKEN = 'A'.repeat(20) + 'b_c-'.repeat(5);
const secret = { token: TOKEN, provided: true };
const cookie = `qe_local=${localWebCookieValue(TOKEN)}`;
const req = (url: string, headers: Record<string, string> = {}, method = 'GET') => ({
  method,
  url,
  headers: { host: '127.0.0.1:3000', ...headers },
});

describe('takeLocalWebSecret', () => {
  it('takes the launcher’s token and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { [LOCAL_WEB_TOKEN_ENV]: TOKEN };
    expect(takeLocalWebSecret(env)).toEqual({ token: TOKEN, provided: true });
    expect(env[LOCAL_WEB_TOKEN_ENV]).toBeUndefined();
  });

  it('generates a fresh 256-bit token per run otherwise', () => {
    const a = takeLocalWebSecret({});
    const b = takeLocalWebSecret({});
    expect(a.provided).toBe(false);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
  });

  it.each(['short', 'x'.repeat(200), 'has spaces in it but is long enough to pass', `${'a'.repeat(40)}&x=1`])(
    'refuses a weak or malformed token %j',
    (token) => {
      expect(() => takeLocalWebSecret({ [LOCAL_WEB_TOKEN_ENV]: token })).toThrow(LOCAL_WEB_TOKEN_ENV);
    },
  );
});

describe('decide (local web access)', () => {
  it('refuses requests without the cookie, for any path', () => {
    for (const path of ['/', '/bundle.js', '/file/etc/passwd', '/services/x']) {
      expect(decide(secret, req(path))).toEqual({ kind: 'refuse', status: 401 });
    }
  });

  it('exchanges the sign-in link for an HttpOnly, SameSite=Strict cookie and drops the token from the address', () => {
    expect(decide(secret, req(`/?folder=%2Fhome&token=${TOKEN}#x`))).toEqual({
      kind: 'sign-in',
      location: '/?folder=%2Fhome',
      cookie: `${cookie}; Path=/; HttpOnly; SameSite=Strict`,
    });
    expect(decide(secret, req(`/?token=${TOKEN}`))).toMatchObject({ location: '/' });
  });

  it('refuses a wrong token, and the token on anything but GET', () => {
    expect(decide(secret, req(`/?token=${'B'.repeat(40)}`))).toEqual({ kind: 'refuse', status: 401 });
    expect(decide(secret, req(`/?token=${TOKEN}`, {}, 'POST'))).toEqual({ kind: 'refuse', status: 401 });
  });

  it('allows the cookie; a forged one is refused', () => {
    expect(decide(secret, req('/bundle.js', { cookie: `other=1; ${cookie}` }))).toEqual({ kind: 'allow' });
    expect(
      decide(
        secret,
        req('/', { cookie: `qe_local=${localWebCookieValue('another-token-of-enough-length-000')}` }),
      ),
    ).toEqual({
      kind: 'refuse',
      status: 401,
    });
    expect(decide(secret, req('/', { cookie: `qe_local=${TOKEN}` }))).toEqual({
      kind: 'refuse',
      status: 401,
    });
  });

  it('refuses any Host but loopback, even with the cookie or the token (DNS rebinding, other interfaces)', () => {
    for (const host of ['evil.example:3000', '192.168.1.20:3000', 'qe.local', '127.0.0.1.evil.example']) {
      expect(decide(secret, req('/', { host, cookie }))).toEqual({ kind: 'refuse', status: 403 });
      expect(decide(secret, req(`/?token=${TOKEN}`, { host }))).toEqual({ kind: 'refuse', status: 403 });
    }
    expect(decide(secret, { url: '/', headers: { cookie } })).toEqual({ kind: 'refuse', status: 403 });
  });

  it('names loopback hosts', () => {
    expect(['127.0.0.1:3000', 'localhost:3000', '[::1]:3000', 'localhost'].every(isLoopbackHost)).toBe(true);
    expect(['', 'localhost.evil:3000', '0.0.0.0:3000', '[::]:3000'].some(isLoopbackHost)).toBe(false);
  });
});

describe('localWebMiddleware', () => {
  const run = (request: ReturnType<typeof req>) => {
    const res = { writeHead: vi.fn(), end: vi.fn() };
    res.writeHead.mockReturnValue(res);
    const next = vi.fn();
    localWebMiddleware(secret)(request as unknown as IncomingMessage, res as unknown as ServerResponse, next);
    return { res, next };
  };

  it('passes signed-in requests on, and nothing else', () => {
    expect(run(req('/', { cookie })).next).toHaveBeenCalled();
    const { res, next } = run(req('/'));
    expect(next).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.objectContaining({ 'cache-control': 'no-store' }));
    expect(String(res.end.mock.calls[0]?.[0])).not.toContain(TOKEN);
  });

  it('answers the sign-in link with a 303 that sets the cookie, uncached and without a referrer', () => {
    const { res } = run(req(`/?token=${TOKEN}`));
    expect(res.writeHead).toHaveBeenCalledWith(303, {
      location: '/',
      'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  });
});

describe('allowsLocalWebUpgrade (WebSocket and Socket.IO handshakes)', () => {
  const upgrade = (headers: Record<string, string>) =>
    ({
      headers: { host: '127.0.0.1:3000', ...headers },
      url: '/socket.io/?EIO=4',
    }) as unknown as IncomingMessage;

  it('needs the cookie and a loopback Host; the token alone never upgrades', () => {
    expect(allowsLocalWebUpgrade(secret, upgrade({ cookie }))).toBe(true);
    expect(allowsLocalWebUpgrade(secret, upgrade({}))).toBe(false);
    expect(allowsLocalWebUpgrade(secret, upgrade({ host: 'evil.example:3000', cookie }))).toBe(false);
    const withToken = {
      headers: { host: '127.0.0.1:3000' },
      url: `/socket.io/?token=${TOKEN}`,
    } as unknown as IncomingMessage;
    expect(allowsLocalWebUpgrade(secret, withToken)).toBe(false);
  });
});

describe('listeningProblem', () => {
  const at = (address: string) => ({ address, family: 'IPv4', port: 3000 });

  it('accepts loopback only, unless the local-web container publishes it on loopback', () => {
    expect(listeningProblem(at('127.0.0.1'), {})).toBeUndefined();
    expect(listeningProblem(at('::1'), {})).toBeUndefined();
    expect(listeningProblem(at('0.0.0.0'), {})).toContain('127.0.0.1 only');
    expect(listeningProblem(at('::'), {})).toContain('127.0.0.1 only');
    expect(listeningProblem(at('192.168.1.20'), {})).toContain('127.0.0.1 only');
    expect(listeningProblem(at('0.0.0.0'), { [LOCAL_WEB_CONTAINER_ENV]: '1' })).toBeUndefined();
  });
});

describe('writeSignInLink', () => {
  it('writes the link to a private file under ~/.qe-workspace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qe-home-'));
    try {
      const file = await writeSignInLink(`http://127.0.0.1:3000/?token=${TOKEN}`, home);
      expect(file).toBe(join(home, '.qe-workspace', 'local-web-url'));
      expect(readFileSync(file, 'utf8')).toBe(`http://127.0.0.1:3000/?token=${TOKEN}\n`);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
