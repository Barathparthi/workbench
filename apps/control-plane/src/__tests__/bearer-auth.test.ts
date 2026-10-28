import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { authorize, makePrincipal, sha256, type Authenticator, type Principal } from '../auth.js';
import {
  bearerToken,
  verifyAccessToken,
  withBearerTokens,
  type AccessTokenExpectations,
} from '../auth/bearer-auth.js';
import { LoginError } from '../auth/oidc.js';
import { errorHandler } from '../errors.js';

const expected: AccessTokenExpectations = {
  issuer: 'https://idp.example/realms/qe',
  audience: 'qe-workspace',
  clientId: 'qe-workspace-desktop',
  groupsClaim: 'groups',
};
const NOW = new Date('2026-10-28T12:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
/** Claims to change; `undefined` leaves a claim out. */
type Overrides = Record<string, unknown>;

let signingKey: PrivateKey;
let otherKey: PrivateKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair('ES256')).privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }] });
});

const claims = (over: Overrides = {}): JWTPayload => {
  const all: Record<string, unknown> = {
    iss: expected.issuer,
    aud: ['qe-workspace', 'account'],
    azp: expected.clientId,
    sub: 'f6b9d4c2-0000-4000-8000-000000000001',
    typ: 'Bearer',
    sid: 'idp-session-1',
    iat: nowSec - 60,
    exp: nowSec + 240,
    preferred_username: 'Bob',
    name: 'Bob Lab',
    email: 'bob@qe.test',
    groups: ['/qe-workspace-users', 'qe-lab-a'],
    ...over,
  };
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined));
};

const sign = (payload: JWTPayload, key: PrivateKey = signingKey): Promise<string> =>
  new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'JWT' }).sign(key);

describe('verifyAccessToken', () => {
  it('accepts a desktop access token and maps it like an ID token', async () => {
    const verified = await verifyAccessToken(await sign(claims()), keys, expected, NOW);
    expect(verified.identity).toEqual({
      issuer: expected.issuer,
      subject: 'f6b9d4c2-0000-4000-8000-000000000001',
      username: 'bob',
      displayName: 'Bob Lab',
      email: 'bob@qe.test',
      groups: ['qe-workspace-users', 'qe-lab-a'],
    });
    expect(verified.signInKey).toBe('sid:idp-session-1');
    expect(verified.expiresAtMs).toBe((nowSec + 240) * 1000);
  });

  it('keys sign-ins by the token itself when the IdP sends no session id', async () => {
    const token = await sign(claims({ sid: undefined }));
    expect((await verifyAccessToken(token, keys, expected, NOW)).signInKey).not.toContain('sid:');
  });

  it.each<[string, Overrides]>([
    ['another issuer', { iss: 'https://evil.example/realms/qe' }],
    ['another audience', { aud: ['account'] }],
    ['another client (azp)', { azp: 'qe-workspace' }],
    ['no azp', { azp: undefined }],
    ['an expired token', { iat: nowSec - 600, exp: nowSec - 60 }],
    ['a token not valid yet', { nbf: nowSec + 120 }],
    ['an ID token', { typ: 'ID' }],
    ['a refresh token', { typ: 'Refresh' }],
    ['a lifetime above one hour', { iat: nowSec - 60, exp: nowSec + 3600 }],
    ['no expiry', { exp: undefined }],
  ])('refuses %s', async (_label, over) => {
    await expect(verifyAccessToken(await sign(claims(over)), keys, expected, NOW)).rejects.toThrow();
  });

  it('refuses a token signed by a key the IdP does not publish', async () => {
    await expect(verifyAccessToken(await sign(claims(), otherKey), keys, expected, NOW)).rejects.toThrow();
  });

  it('refuses an unsigned token (alg none)', async () => {
    const token = new UnsecuredJWT(claims()).encode();
    await expect(verifyAccessToken(token, keys, expected, NOW)).rejects.toThrow();
  });

  it('refuses an HMAC token, whatever its secret', async () => {
    const secret = new TextEncoder().encode('x'.repeat(32));
    const token = await new SignJWT(claims()).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(secret);
    await expect(verifyAccessToken(token, keys, expected, NOW)).rejects.toThrow();
  });

  it('reports unusable claims of a genuine token as invalid_claims', async () => {
    const token = await sign(claims({ preferred_username: 'not a username!' }));
    const error: unknown = await verifyAccessToken(token, keys, expected, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).reason).toBe('invalid_claims');
  });
});

describe('bearerToken', () => {
  it.each<[string, string | undefined]>([
    ['Bearer abcdefghijklmnop.qrstuv.wxyz', 'abcdefghijklmnop.qrstuv.wxyz'],
    ['Bearer short', undefined],
    ['bearer abcdefghijklmnop.qrstuv.wxyz', undefined],
    ['Basic dXNlcjpwYXNzd29yZA==', undefined],
    ['Bearer abc def ghi jkl mno pqr', undefined],
    [`Bearer ${'a'.repeat(9000)}`, undefined],
  ])('reads %j', (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });
});

describe('authorize with desktop bearer tokens', () => {
  const user = makePrincipal({
    userId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70',
    username: 'u',
    roles: ['qe.user'],
  });
  const cookieUser = makePrincipal({
    userId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d71',
    username: 'cookie',
    roles: ['qe.admin'],
  });
  const GOOD = 'good-token-0123456789';
  const sessions: Authenticator = {
    authenticate: (input) =>
      Promise.resolve(
        input.cookies['qews_session'] === 'valid'
          ? { kind: 'session', session: { principal: cookieUser, sessionId: 's1', csrfHash: sha256('csrf') } }
          : undefined,
      ),
  };

  async function appWith(
    bearer: (token: string) => Promise<Principal | undefined>,
  ): Promise<{ app: FastifyInstance; seen: () => unknown }> {
    let method: unknown;
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(cookie);
    app.addHook('onRequest', authorize(withBearerTokens(sessions, bearer)));
    app.route({
      method: 'POST',
      url: '/write',
      config: { permission: 'workspace:create', audit: false },
      handler: (request) => {
        method = request.authMethod;
        return { user: request.principal?.username };
      },
    });
    await app.ready();
    return { app, seen: () => method };
  }

  const tokens = (token: string) => Promise.resolve(token === GOOD ? user : undefined);

  it('accepts a valid token on an unsafe method without a CSRF token (no ambient credential)', async () => {
    const { app, seen } = await appWith(tokens);
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: `Bearer ${GOOD}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: 'u' });
    expect(seen()).toBe('bearer');
  });

  it('judges a request with a bad token on the token alone, never on its cookie', async () => {
    const { app } = await appWith(tokens);
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: {
        authorization: 'Bearer bad-token-0123456789',
        cookie: 'qews_session=valid',
        'x-csrf-token': 'csrf',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses other authorization schemes without asking the token check', async () => {
    const bearer = vi.fn(tokens);
    const { app } = await appWith(bearer);
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: 'Basic dXNlcjpwYXNzd29yZA==', cookie: 'qews_session=valid' },
    });
    expect(res.statusCode).toBe(401);
    expect(bearer).not.toHaveBeenCalled();
  });

  it('leaves cookie sessions as they were when no Authorization header is sent', async () => {
    const { app, seen } = await appWith(tokens);
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { cookie: 'qews_session=valid', 'x-csrf-token': 'csrf' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: 'cookie' });
    expect(seen()).toBe('session');
  });
});
