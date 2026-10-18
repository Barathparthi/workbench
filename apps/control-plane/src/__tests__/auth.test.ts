import { DomainError } from '@qe/domain';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  authorize,
  csrfMatches,
  devAuthenticator,
  makePrincipal,
  noAuthenticator,
  sha256,
  type Authenticator,
  type RoutePermission,
} from '../auth.js';
import { codeChallenge, identityFromClaims, LoginError, newLoginChecks } from '../auth/oidc.js';
import { safeReturnTo } from '../auth/return-to.js';
import { errorHandler } from '../errors.js';

const user = makePrincipal({
  userId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70',
  username: 'u',
  roles: ['qe.user'],
});
const CSRF = 'csrf-token-value';

const deniedSpy = () => vi.fn<NonNullable<Authenticator['recordDenied']>>(() => Promise.resolve());

const sessionAuthenticator = (recordDenied = deniedSpy()): Authenticator => ({
  authenticate: () =>
    Promise.resolve({
      kind: 'session',
      session: { principal: user, sessionId: 's1', csrfHash: sha256(CSRF) },
    }),
  recordDenied,
});

async function appWith(authenticator: Authenticator): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', authorize(authenticator));
  const route = (method: 'GET' | 'POST', url: string, permission: RoutePermission, audit = false) =>
    app.route({ method, url, config: { permission, audit }, handler: () => ({ ok: true }) });
  route('GET', '/public', 'public');
  route('GET', '/me', 'authenticated');
  route('GET', '/read', 'workspace:read');
  route('POST', '/write', 'workspace:create', true);
  route('GET', '/audit', 'audit:read', true);
  route('GET', '/quiet', 'audit:read', false);
  route('POST', '/admin', 'platform:admin', true);
  await app.ready();
  return app;
}

describe('authorize', () => {
  it('lets public routes through without credentials', async () => {
    const app = await appWith(noAuthenticator);
    expect((await app.inject({ url: '/public' })).statusCode).toBe(200);
  });

  it.each(['/me', '/read', '/audit'])('answers 401 AUTH_REQUIRED on %s without credentials', async (url) => {
    const res = await (await appWith(noAuthenticator)).inject({ url });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('allows authenticated routes and held permissions', async () => {
    const app = await appWith(devAuthenticator(user));
    expect((await app.inject({ url: '/me' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/read' })).statusCode).toBe(200);
  });

  it('refuses a missing permission with 403 FORBIDDEN', async () => {
    const res = await (await appWith(devAuthenticator(user))).inject({ url: '/audit' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('audits denials of audited routes only', async () => {
    const denied = deniedSpy();
    const app = await appWith(sessionAuthenticator(denied));
    await app.inject({ url: '/quiet' });
    expect(denied).not.toHaveBeenCalled();
    await app.inject({ url: '/audit' });
    expect(denied).toHaveBeenCalledOnce();
    expect(denied.mock.calls[0]?.[2]).toBe('audit:read');
  });

  it('still answers 403 when auditing the denial fails', async () => {
    const auth = sessionAuthenticator(vi.fn(() => Promise.reject(new Error('db down'))));
    const res = await (await appWith(auth)).inject({ url: '/audit' });
    expect(res.statusCode).toBe(403);
  });

  describe('CSRF for cookie sessions', () => {
    it('does not need a token on safe methods', async () => {
      expect((await (await appWith(sessionAuthenticator())).inject({ url: '/read' })).statusCode).toBe(200);
    });

    it.each([
      ['no token', {}],
      ['a wrong token', { 'x-csrf-token': 'nope' }],
      ['an empty token', { 'x-csrf-token': '' }],
      ['an oversized token', { 'x-csrf-token': 'x'.repeat(300) }],
    ])('refuses an unsafe request with %s', async (_label, headers) => {
      const res = await (
        await appWith(sessionAuthenticator())
      ).inject({ method: 'POST', url: '/write', headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    });

    it('accepts the session token', async () => {
      const res = await (
        await appWith(sessionAuthenticator())
      ).inject({
        method: 'POST',
        url: '/write',
        headers: { 'x-csrf-token': CSRF },
      });
      expect(res.statusCode).toBe(200);
    });

    it('checks CSRF before permissions, so forged requests are not audited as denials', async () => {
      const denied = deniedSpy();
      const res = await (
        await appWith(sessionAuthenticator(denied))
      ).inject({ method: 'POST', url: '/admin' });
      expect(res.json()).toMatchObject({ code: 'CSRF_REJECTED' });
      expect(denied).not.toHaveBeenCalled();
    });
  });

  it('dev mode never asks for CSRF tokens', async () => {
    const res = await (await appWith(devAuthenticator(user))).inject({ method: 'POST', url: '/write' });
    expect(res.statusCode).toBe(200);
  });

  it('propagates authenticator failures as errors', async () => {
    const failing: Authenticator = { authenticate: () => Promise.reject(new DomainError('INTERNAL_ERROR')) };
    expect((await (await appWith(failing)).inject({ url: '/me' })).statusCode).toBe(500);
  });
});

describe('csrfMatches', () => {
  it('compares against the stored hash', () => {
    expect(csrfMatches(CSRF, sha256(CSRF))).toBe(true);
    expect(csrfMatches(`${CSRF}x`, sha256(CSRF))).toBe(false);
    expect(csrfMatches(['a'], sha256(CSRF))).toBe(false);
    expect(csrfMatches(undefined, sha256(CSRF))).toBe(false);
  });
});

describe('makePrincipal', () => {
  it('derives permissions from roles and sorts roles', () => {
    const p = makePrincipal({ userId: 'id', username: 'u', roles: ['qe.user', 'auditor'] });
    expect(p.roles).toEqual(['auditor', 'qe.user']);
    expect(p.permissions.has('audit:read')).toBe(true);
    expect(p.displayName).toBe('u');
  });
});

describe('safeReturnTo (T21 open redirect)', () => {
  it.each([
    ['/', '/'],
    ['/w/abc/', '/w/abc/'],
    ['/a?b=c#d', '/a?b=c#d'],
    ['/a/../b', '/b'],
  ])('keeps %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    42,
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example',
    '\\\\evil.example',
    '/\tevil',
    '/\n/evil',
    'javascript:alert(1)',
    'evil',
    `/${'a'.repeat(3000)}`,
  ])('replaces %j with /', (input) => {
    expect(safeReturnTo(input)).toBe('/');
  });
});

describe('OIDC helpers', () => {
  it('computes the RFC 7636 S256 challenge (appendix B vector)', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates fresh, distinct, 256-bit checks', () => {
    const a = newLoginChecks();
    const b = newLoginChecks();
    expect(a.state).not.toBe(b.state);
    expect(new Set([a.state, a.nonce, a.codeVerifier]).size).toBe(3);
    expect(Buffer.from(a.codeVerifier, 'base64url')).toHaveLength(32);
  });

  const claims = {
    iss: 'https://idp.example/realms/qe',
    sub: 'abc-123',
    preferred_username: 'Alice.Smith',
    name: 'Alice Smith',
    email: 'alice@example.com',
    groups: ['/qe-workspace-users', 'qe-lab-a'],
  };

  it('maps claims to an identity, lower-casing the username and trimming group paths', () => {
    expect(identityFromClaims(claims, 'groups')).toEqual({
      issuer: claims.iss,
      subject: 'abc-123',
      username: 'alice.smith',
      displayName: 'Alice Smith',
      email: 'alice@example.com',
      groups: ['qe-workspace-users', 'qe-lab-a'],
    });
  });

  it('treats a missing groups claim as no groups and falls back to the username for the name', () => {
    const rest: Record<string, unknown> = { ...claims };
    delete rest.groups;
    delete rest.name;
    const identity = identityFromClaims(rest, 'groups');
    expect(identity.groups).toEqual([]);
    expect(identity.displayName).toBe('alice.smith');
  });

  it.each([
    ['no username', { ...claims, preferred_username: undefined }],
    ['a username with a shell metacharacter', { ...claims, preferred_username: 'a;rm' }],
    ['a username starting with a dash', { ...claims, preferred_username: '-oProxyCommand' }],
    ['a too-long username', { ...claims, preferred_username: 'a'.repeat(65) }],
    ['groups that are not strings', { ...claims, groups: [1] }],
    ['groups that are not a list', { ...claims, groups: 'admins' }],
    ['no subject', { ...claims, sub: '' }],
  ])('rejects %s', (_label, bad) => {
    expect(() => identityFromClaims(bad, 'groups')).toThrow(LoginError);
  });
});
