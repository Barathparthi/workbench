import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { makePrincipal, sha256, type AuthInput } from '../auth.js';
import { LoginError } from '../auth/oidc.js';
import { safeReturnTo } from '../auth/return-to.js';
import type { LoginTransaction, SessionAuth } from '../auth/session-auth.js';
import { buildServer } from '../server.js';
import { fakeHealth, fakeWorkspaces, testConfig } from './fixtures.js';

const SECRET = 'cookie-signing-secret-for-tests-only-32+';
const SESSION_TOKEN = 'session-token';
const CSRF = 'csrf-token';
const alice = makePrincipal({
  userId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d71',
  username: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  roles: ['qe.user', 'lab.a.user'],
});

function fakeAuth(overrides: Partial<SessionAuth> = {}) {
  const auth = {
    authenticate: (request: AuthInput) =>
      Promise.resolve(
        request.cookies.qews_session === SESSION_TOKEN
          ? {
              kind: 'session' as const,
              session: { principal: alice, sessionId: 's-1', csrfHash: sha256(CSRF) },
            }
          : undefined,
      ),
    startLogin: vi.fn((returnTo: unknown) =>
      Promise.resolve({
        redirectUrl: 'https://idp.example/auth?client_id=qe',
        transaction: {
          state: 'state-1',
          nonce: 'nonce-1',
          codeVerifier: 'v'.repeat(43),
          returnTo: safeReturnTo(returnTo),
          expiresAt: Date.now() + 600_000,
        } satisfies LoginTransaction,
      }),
    ),
    finishLogin: vi.fn((input: Parameters<SessionAuth['finishLogin']>[0]) =>
      Promise.resolve({
        sessionId: 's-1',
        token: SESSION_TOKEN,
        csrfToken: CSRF,
        maxAgeSec: 28_800,
        returnTo: input.transaction?.returnTo ?? '/',
      }),
    ),
    logout: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  return auth;
}

async function server(auth = fakeAuth(), cookieSecure = true): Promise<FastifyInstance> {
  return buildServer(testConfig({ AUTH_MODE: 'oidc' }), {
    workspaces: fakeWorkspaces(),
    health: fakeHealth(),
    sessions: {
      auth,
      redirectUrl: 'https://qe.example/auth/callback',
      publicOrigin: 'https://qe.example',
      cookieSecure,
      cookieSecret: SECRET,
    },
  });
}

const cookieHeader = (res: { cookies: { name: string; value: string }[] }, name: string) => {
  const c = res.cookies.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no ${name} cookie`);
  return `${name}=${c.value}`;
};

describe('GET /auth/login', () => {
  it('redirects to the IdP with a signed, HttpOnly transaction cookie scoped to /auth', async () => {
    const auth = fakeAuth();
    const res = await (await server(auth)).inject({ url: '/auth/login?returnTo=/w/abc/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://idp.example/auth?client_id=qe');
    expect(res.headers['cache-control']).toBe('no-store');
    const cookie = res.cookies.find((c) => c.name === 'qews_oidc');
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/auth',
      maxAge: 600,
    });
    // Signed: "<base64url payload>.<signature>"; the payload is readable but cannot be forged.
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9+/=_-]+$/);
    expect(auth.startLogin).toHaveBeenCalledWith('/w/abc/');
  });
});

describe('GET /auth/callback', () => {
  async function loginRoundTrip(auth = fakeAuth(), query = '?code=c&state=state-1') {
    const app = await server(auth);
    const login = await app.inject({ url: '/auth/login?returnTo=/w/abc/' });
    return app.inject({
      url: `/auth/callback${query}`,
      headers: { cookie: cookieHeader(login, 'qews_oidc') },
    });
  }

  it('creates the session and lands on PUBLIC_ORIGIN + returnTo', async () => {
    const auth = fakeAuth();
    const res = await loginRoundTrip(auth);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('https://qe.example/w/abc/');
    const session = res.cookies.find((c) => c.name === 'qews_session');
    const csrf = res.cookies.find((c) => c.name === 'qews_csrf');
    expect(session).toMatchObject({
      value: SESSION_TOKEN,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    });
    expect(csrf).toMatchObject({ value: CSRF, secure: true, sameSite: 'Lax', path: '/' });
    expect(csrf?.httpOnly).toBeFalsy();
    const input = vi.mocked(auth.finishLogin).mock.calls[0]?.[0];
    expect(input?.transaction).toMatchObject({ state: 'state-1', nonce: 'nonce-1', returnTo: '/w/abc/' });
    expect(input?.callbackUrl.href).toBe('https://qe.example/auth/callback?code=c&state=state-1');
    expect(input?.idpError).toBe(false);
  });

  it('passes no transaction when the cookie is missing or tampered with', async () => {
    const auth = fakeAuth();
    const app = await server(auth);
    await app.inject({ url: '/auth/callback?code=c&state=s' });
    const forged = Buffer.from(JSON.stringify({ state: 'x' })).toString('base64url');
    await app.inject({
      url: '/auth/callback?code=c&state=s',
      headers: { cookie: `qews_oidc=${forged}.bad` },
    });
    expect(vi.mocked(auth.finishLogin).mock.calls.map((c) => c[0].transaction)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('reports IdP errors to the service', async () => {
    const auth = fakeAuth();
    await loginRoundTrip(auth, '?error=access_denied&state=state-1');
    expect(vi.mocked(auth.finishLogin).mock.calls[0]?.[0].idpError).toBe(true);
  });

  it('answers a failed login with 401 and no reason detail, setting no session', async () => {
    const auth = fakeAuth({ finishLogin: () => Promise.reject(new LoginError('user_disabled')) });
    const res = await loginRoundTrip(auth);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(res.body).not.toContain('disabled');
    expect(res.cookies.find((c) => c.name === 'qews_session')).toBeUndefined();
  });

  it('clears the transaction cookie whatever the outcome', async () => {
    const res = await loginRoundTrip();
    expect(res.cookies.find((c) => c.name === 'qews_oidc')?.maxAge).toBe(0);
  });

  it('allows plain-http cookies only when configured (local development)', async () => {
    const res = await (await server(fakeAuth(), false)).inject({ url: '/auth/login' });
    expect(res.cookies.find((c) => c.name === 'qews_oidc')?.secure).toBeFalsy();
  });
});

describe('POST /auth/logout', () => {
  const sessionCookie = `qews_session=${SESSION_TOKEN}`;

  it('needs a session', async () => {
    expect((await (await server()).inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(401);
  });

  it('needs the CSRF token', async () => {
    const auth = fakeAuth();
    const res = await (
      await server(auth)
    ).inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: sessionCookie },
    });
    expect(res.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('ends the session and clears both cookies', async () => {
    const auth = fakeAuth();
    const res = await (
      await server(auth)
    ).inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: sessionCookie, 'x-csrf-token': CSRF },
    });
    expect(res.statusCode).toBe(204);
    expect(auth.logout).toHaveBeenCalledOnce();
    for (const name of ['qews_session', 'qews_csrf']) {
      expect(res.cookies.find((c) => c.name === name)?.maxAge).toBe(0);
    }
  });
});

describe('GET /api/v1/me', () => {
  it('describes the signed-in user and their permissions', async () => {
    const res = await (
      await server()
    ).inject({ url: '/api/v1/me', headers: { cookie: `qews_session=${SESSION_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const me = res.json<{ username: string; roles: string[]; permissions: string[] }>();
    expect(me).toMatchObject({ username: 'alice', displayName: 'Alice', email: 'alice@example.com' });
    expect(me.roles).toEqual(['lab.a.user', 'qe.user']);
    expect(me.permissions).toContain('remote:connect');
    expect(me.permissions).not.toContain('audit:read');
    expect([...me.permissions].sort()).toEqual(me.permissions);
  });

  it('is 401 without a session', async () => {
    expect((await (await server()).inject({ url: '/api/v1/me' })).statusCode).toBe(401);
  });

  it('is 401 for an unknown session token', async () => {
    const res = await (
      await server()
    ).inject({ url: '/api/v1/me', headers: { cookie: 'qews_session=forged' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('unknown routes', () => {
  it('need a session first, so paths cannot be enumerated anonymously', async () => {
    const app = await server();
    expect((await app.inject({ url: '/api/v1/nope' })).statusCode).toBe(401);
    const signedIn = await app.inject({
      url: '/api/v1/nope',
      headers: { cookie: `qews_session=${SESSION_TOKEN}` },
    });
    expect(signedIn.statusCode).toBe(404);
  });
});
