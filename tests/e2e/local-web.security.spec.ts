/**
 * Local web mode's access check against the real IDE backend (PHASE_10 §10.6, security tests): nothing without the
 * sign-in cookie — pages, bundles, Socket.IO and WebSocket handshakes alike —, the link's token exchanged once for an
 * HttpOnly cookie, no use of that cookie under another Host name (DNS rebinding), and nothing on other interfaces.
 */
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

import { expect, test } from '@playwright/test';

const PORT = 3030;
const token = process.env['QE_E2E_LOCAL_TOKEN'] ?? '';

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request, so Host and Cookie are exactly what the test says (no browser rules). */
function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, path, headers: { host: `127.0.0.1:${String(PORT)}`, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A WebSocket handshake to Theia's Socket.IO endpoint: 101 when allowed, the refusal's status otherwise. */
function upgrade(headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path: '/socket.io/?EIO=4&transport=websocket',
      headers: {
        host: `127.0.0.1:${String(PORT)}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** The cookie the sign-in link sets. */
async function signedInCookie(): Promise<string> {
  const res = await get(`/?token=${token}`);
  const setCookie = [res.headers['set-cookie'] ?? []].flat()[0] ?? '';
  return setCookie.split(';')[0] ?? '';
}

test.describe('local web access', () => {
  test('serves nothing without the sign-in cookie', async () => {
    for (const path of [
      '/',
      '/bundle.js',
      '/favicon.ico',
      '/file/etc/hostname',
      '/socket.io/?EIO=4&transport=polling',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain(token);
    }
    expect((await get('/')).status).toBe(401);
    expect(await upgrade()).not.toBe(101);
  });

  test('refuses a wrong token', async () => {
    const res = await get(`/?token=${randomBytes(32).toString('base64url')}`);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('exchanges the link for an HttpOnly, SameSite=Strict cookie and drops the token from the address', async () => {
    const res = await get(`/?token=${token}`);
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/');
    const setCookie = [res.headers['set-cookie'] ?? []].flat()[0] ?? '';
    expect(setCookie).toMatch(/^qe_local=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(setCookie).not.toContain(token);
  });

  test('the cookie opens the IDE and its WebSocket; the token alone never upgrades', async () => {
    const cookie = await signedInCookie();
    expect((await get('/', { cookie })).status).toBe(200);
    expect(await upgrade({ cookie })).toBe(101);
    expect(await upgrade()).not.toBe(101);
  });

  test('refuses the cookie under any other Host name (DNS rebinding)', async () => {
    const cookie = await signedInCookie();
    for (const host of [`evil.example:${String(PORT)}`, `192.168.0.10:${String(PORT)}`]) {
      expect((await get('/', { host, cookie })).status).toBe(403);
      expect(await upgrade({ host, cookie })).not.toBe(101);
    }
  });

  test('is not reachable on the machine’s other interfaces', async () => {
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a !== undefined && !a.internal && a.family === 'IPv4')
      .map((a) => a?.address ?? '');
    test.skip(others.length === 0, 'this machine has no non-loopback IPv4 interface');
    for (const address of others) {
      const outcome = await new Promise<string>((resolve) => {
        const socket = connect({ host: address, port: PORT, timeout: 3_000 });
        socket.on('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve('timeout');
        });
        socket.on('error', (e: NodeJS.ErrnoException) => {
          resolve(e.code ?? 'error');
        });
      });
      expect(outcome, address).not.toBe('connected');
    }
  });
});
