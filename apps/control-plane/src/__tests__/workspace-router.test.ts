/**
 * Workspace router (Phase 05 §5.7) against a real local upstream standing in for Theia: HTTP and WebSocket
 * proxying, membership/state checks, credential stripping, cookie path scoping. No Docker needed.
 */
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import type { WorkspaceState } from '@qe/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { makePrincipal, sha256, type AuthInput } from '../auth.js';
import type { SessionAuth } from '../auth/session-auth.js';
import { scopeSetCookie, upstreamHeaders } from '../router/workspace-router.js';
import { buildServer } from '../server.js';
import { WorkspaceEvents, type WorkspaceLifecycle } from '../workspace-lifecycle.js';
import { fakeHealth, fakeWorkspaces, logSink, testConfig } from './fixtures.js';

const WS = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const OTHER = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d60';
const ORIGIN = 'https://qe.example';
const alice = makePrincipal({
  userId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d71',
  username: 'alice',
  roles: ['qe.user'],
});

let upstream: Server;
let upstreamUrl: string;
let lastRequest: IncomingMessage | undefined;
const upstreamSockets = new Set<Duplex>();
let app: FastifyInstance;
let base: string;
let state: WorkspaceState = 'RUNNING';
const events = new WorkspaceEvents();
const touch = vi.fn(() => Promise.resolve());

const auth: SessionAuth = {
  authenticate: (input: AuthInput) =>
    Promise.resolve(
      input.cookies.qews_session === 'alice'
        ? { kind: 'session', session: { principal: alice, sessionId: 's-alice', csrfHash: sha256('csrf') } }
        : undefined,
    ),
  startLogin: () => Promise.reject(new Error('unused')),
  finishLogin: () => Promise.reject(new Error('unused')),
  logout: () => Promise.resolve(),
};

beforeAll(async () => {
  upstream = createServer((req, res) => {
    lastRequest = req;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // Theia's first page sets exactly one cookie; undici hands a single Set-Cookie over as a string.
      if (req.url === '/one-cookie') res.setHeader('set-cookie', 'theia-connection-token=abc; Path=/');
      else res.setHeader('set-cookie', ['theia-connection-token=abc; Path=/; HttpOnly', 'plain=1']);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
    });
  });
  upstream.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    lastRequest = req;
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
    socket.on('end', () => socket.destroy());
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nset-cookie: t=1; Path=/\r\n\r\n',
    );
    socket.on('data', (d: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;

  const lifecycle = { events } as unknown as WorkspaceLifecycle;
  app = await buildServer(testConfig({ AUTH_MODE: 'oidc', ALLOWED_ORIGINS: [ORIGIN] }), {
    workspaces: fakeWorkspaces(),
    health: fakeHealth(),
    logStream: logSink().stream,
    sessions: {
      auth,
      redirectUrl: `${ORIGIN}/auth/callback`,
      publicOrigin: ORIGIN,
      cookieSecure: true,
      cookieSecret: 'x'.repeat(32),
    },
    runtime: {
      lifecycle,
      lookup: (id) =>
        Promise.resolve(
          id === WS ? { state, runtime_ref: state === 'RUNNING' ? upstreamUrl : null } : undefined,
        ),
      touch,
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  // Keep-alive sockets from the test's own HTTP client would hold both servers open.
  app.server.closeAllConnections();
  await app.close();
  for (const socket of upstreamSockets) socket.destroy();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
});

const cookie = 'qews_session=alice; qews_csrf=csrf; theia-connection-token=abc';

describe('HTTP through /w/{id}/', () => {
  it('proxies to the runtime with the prefix stripped', async () => {
    const res = await app.inject({ url: `/w/${WS}/static/app.js?v=1`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: 'GET', url: '/static/app.js?v=1' });
    expect(touch).toHaveBeenCalledWith(WS);
  });

  it('never forwards platform cookies, Authorization or the CSRF header — but keeps Theia cookies', async () => {
    await app.inject({
      url: `/w/${WS}/`,
      headers: { cookie, authorization: 'Bearer secret', 'x-csrf-token': 'csrf' },
    });
    expect(lastRequest?.headers.cookie).toBe('theia-connection-token=abc');
    expect(lastRequest?.headers.authorization).toBeUndefined();
    expect(lastRequest?.headers['x-csrf-token']).toBeUndefined();
  });

  it('scopes runtime cookies to the workspace path', async () => {
    const res = await app.inject({ url: `/w/${WS}/`, headers: { cookie } });
    expect(res.headers['set-cookie']).toEqual([
      `theia-connection-token=abc; Path=/w/${WS}/; HttpOnly`,
      `plain=1; Path=/w/${WS}/`,
    ]);
  });

  it('scopes a single runtime cookie too', async () => {
    const res = await app.inject({ url: `/w/${WS}/one-cookie`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBe(`theia-connection-token=abc; Path=/w/${WS}/`);
  });

  it('passes request bodies through unparsed (needs an allowed Origin, not the CSRF token)', async () => {
    const payload = '{"not":"parsed by the control plane"';
    const ok = await app.inject({
      method: 'POST',
      url: `/w/${WS}/upload`,
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      payload,
    });
    expect(ok.json()).toMatchObject({ method: 'POST', body: payload });
    const noOrigin = await app.inject({
      method: 'POST',
      url: `/w/${WS}/upload`,
      headers: { cookie },
      payload: 'x',
    });
    expect(noOrigin.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    const evil = await app.inject({
      method: 'POST',
      url: `/w/${WS}/upload`,
      headers: { cookie, origin: 'https://evil.example' },
      payload: 'x',
    });
    expect(evil.statusCode).toBe(403);
  });

  it('redirects /w/{id} to /w/{id}/', async () => {
    const res = await app.inject({ url: `/w/${WS}?a=1`, headers: { cookie } });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe(`/w/${WS}/?a=1`);
  });

  it('needs a session (401), membership (404) and a running workspace (409)', async () => {
    expect((await app.inject({ url: `/w/${WS}/` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/w/${OTHER}/`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/w/not-a-uuid/`, headers: { cookie } })).statusCode).toBe(404);
    state = 'STOPPED';
    events.emit({ id: WS, state: 'STOPPED', reason: null }); // clears the router's cache
    const res = await app.inject({ url: `/w/${WS}/`, headers: { cookie } });
    expect(res.json()).toMatchObject({ status: 409, code: 'WORKSPACE_NOT_READY' });
    state = 'RUNNING';
  });
});

/** Opens a raw WebSocket-style upgrade and returns the socket (or the refusal status). */
function upgrade(
  path: string,
  headers: Record<string, string>,
): Promise<{ socket?: Duplex; status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, {
      headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers },
    });
    req.on('upgrade', (res, socket) => {
      resolve({ socket, status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on('response', (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}

const readOnce = (socket: Duplex) =>
  new Promise<string>((r) =>
    socket.once('data', (d: Buffer) => {
      r(d.toString());
    }),
  );

describe('WebSocket upgrades through /w/{id}/', () => {
  it('connects to the runtime, strips platform cookies and scopes Set-Cookie', async () => {
    const res = await upgrade(`/w/${WS}/services`, { cookie, origin: ORIGIN });
    expect(res.status).toBe(101);
    expect(res.headers['set-cookie']).toEqual([`t=1; Path=/w/${WS}/`]);
    expect(lastRequest?.url).toBe('/services');
    expect(lastRequest?.headers.cookie).toBe('theia-connection-token=abc');
    // Theia accepts a WebSocket only when the Origin's host equals Host (or THEIA_HOSTS lists it).
    expect(lastRequest?.headers.host).toBe(new URL(base).host);
    res.socket?.write('ping');
    expect(await readOnce(res.socket as Duplex)).toBe('echo:ping');
    res.socket?.destroy();
  });

  it.each([
    ['no Origin', { cookie }, 403],
    ['a foreign Origin', { cookie, origin: 'https://evil.example' }, 403],
    ['no session', { origin: ORIGIN }, 401],
  ])('refuses %s', async (_label, headers, status) => {
    expect((await upgrade(`/w/${WS}/services`, headers)).status).toBe(status);
  });

  it('refuses non-members and paths outside /w/{id}/', async () => {
    expect((await upgrade(`/w/${OTHER}/services`, { cookie, origin: ORIGIN })).status).toBe(404);
    expect((await upgrade('/api/v1/me', { cookie, origin: ORIGIN })).status).toBe(404);
  });

  it('closes proxied sockets when the workspace stops', async () => {
    const res = await upgrade(`/w/${WS}/services`, { cookie, origin: ORIGIN });
    const closed = new Promise((r) => res.socket?.on('close', r));
    events.emit({ id: WS, state: 'STOPPING', reason: null });
    await closed;
  });
});

describe('header helpers', () => {
  it('drops only platform cookies', () => {
    expect(upstreamHeaders({ cookie: 'qews_session=a; qews_oidc=b; x=1' }).cookie).toBe('x=1');
    expect(upstreamHeaders({ cookie: 'qews_session=a' })).not.toHaveProperty('cookie');
  });

  it('rewrites or adds the cookie path', () => {
    expect(scopeSetCookie('a=1; path=/; Secure', WS)).toBe(`a=1; Path=/w/${WS}/; Secure`);
    expect(scopeSetCookie('a=1', WS)).toBe(`a=1; Path=/w/${WS}/`);
  });
});
