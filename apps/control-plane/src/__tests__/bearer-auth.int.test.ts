/** Desktop bearer tokens against a real PostgreSQL, with locally signed tokens (Keycloak: oidc-keycloak.int.test.ts). */
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../audit/audit-writer.js';
import { createBearerAuth, withBearerTokens } from '../auth/bearer-auth.js';
import type { OidcProvider } from '../auth/oidc.js';
import { createSessionAuth } from '../auth/session-auth.js';
import { oidcSettings } from '../config.js';
import { UsersRepo } from '../repos/users.js';
import { buildServer } from '../server.js';
import { createWorkspaceService } from '../workspace-service.js';
import { fakeHealth, logSink, testConfig } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

const ISSUER = 'https://idp.test/realms/qe';
const config = testConfig({
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: 'qe-workspace',
  OIDC_CLIENT_SECRET: 'test-secret',
  OIDC_REDIRECT_URL: 'https://qe.example/auth/callback',
  OIDC_DESKTOP_CLIENT_ID: 'qe-workspace-desktop',
  SESSION_SECRET: 'x'.repeat(40),
  ROLE_MAPPINGS: { 'qe-users': ['qe.user'], 'qe-lab-a': ['lab.a.user'] },
});
const settings = oidcSettings(config);
const desktop = settings.desktop ?? { clientId: '', audience: '' };
const noIdp: OidcProvider = {
  authorizationUrl: () => Promise.reject(new Error('not used')),
  exchange: () => Promise.reject(new Error('not used')),
};

let t: TestDatabase;
let app: FastifyInstance;
let sign: (claims: JWTPayload) => Promise<string>;
const nowSec = () => Math.floor(Date.now() / 1000);

const token = (sub: string, username: string, over: JWTPayload = {}) =>
  sign({
    iss: ISSUER,
    aud: desktop.audience,
    azp: desktop.clientId,
    typ: 'Bearer',
    sub,
    sid: `sid-${sub}`,
    iat: nowSec(),
    exp: nowSec() + 300,
    preferred_username: username,
    groups: ['qe-users'],
    ...over,
  });
const me = (bearer: string) =>
  app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${bearer}` } });
const auditRows = () =>
  t.db
    .selectFrom('audit_events')
    .select(['action', 'reason_code', 'metadata_json', 'actor_user_id'])
    .orderBy('seq')
    .execute();

beforeAll(async () => {
  t = await startTestDatabase();
  const pair = await generateKeyPair('ES256');
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }],
  });
  sign = (claims) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).sign(pair.privateKey);
  app = await buildServer(config, {
    workspaces: createWorkspaceService(t.db, 'docker'),
    health: fakeHealth(),
    logStream: logSink().stream,
    sessions: {
      auth: withBearerTokens(
        createSessionAuth(t.db, noIdp, settings),
        createBearerAuth(t.db, keys, {
          issuer: ISSUER,
          audience: desktop.audience,
          clientId: desktop.clientId,
          groupsClaim: settings.groupsClaim,
          roleMappings: settings.roleMappings,
        }),
      ),
      redirectUrl: settings.redirectUrl,
      publicOrigin: settings.publicOrigin,
      cookieSecure: true,
      cookieSecret: settings.sessionSecret,
    },
  });
});
afterAll(async () => {
  await app.close();
  await t.stop();
});

describe('desktop bearer tokens (PostgreSQL)', () => {
  it('signs the user in on first sight, with roles from the token’s groups, and audits it once per IdP session', async () => {
    const first = await me(await token('sub-dana', 'dana', { groups: ['qe-users', 'qe-lab-a'] }));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ username: 'dana', roles: ['lab.a.user', 'qe.user'] });
    // A refreshed token of the same IdP session: groups follow the IdP, no second sign-in event.
    const refreshed = await me(await token('sub-dana', 'dana', { groups: ['qe-users'] }));
    expect(refreshed.json()).toMatchObject({ roles: ['qe.user'] });
    // A new sign-in (another IdP session) is audited again.
    expect((await me(await token('sub-dana', 'dana', { sid: 'sid-2' }))).statusCode).toBe(200);

    const rows = (await auditRows()).filter((r) => r.action === 'AUTH_LOGIN_SUCCESS');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.metadata_json).toEqual({ method: 'desktop_token', roles: ['lab.a.user', 'qe.user'] });
    expect(JSON.stringify(await auditRows())).not.toContain('eyJ'); // no token ever reaches the audit log
  });

  it('refuses a disabled user, even with a token it already accepted', async () => {
    const bearer = await token('sub-erin', 'erin');
    expect((await me(bearer)).statusCode).toBe(200);
    const user = await t.db
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'erin')
      .executeTakeFirstOrThrow();
    await new UsersRepo(t.db).setStatus(user.id, 'disabled');
    expect((await me(bearer)).statusCode).toBe(401);
    expect((await me(await token('sub-erin', 'erin', { sid: 'sid-new' }))).statusCode).toBe(401);
    expect((await auditRows()).map((r) => `${r.action}:${r.reason_code ?? ''}`)).toContain(
      'AUTH_LOGIN_FAILURE:user_disabled',
    );
  });

  it('refuses a username already taken by another identity, and audits it', async () => {
    expect((await me(await token('sub-other-dana', 'dana'))).statusCode).toBe(401);
    expect((await auditRows()).map((r) => `${r.action}:${r.reason_code ?? ''}`)).toContain(
      'AUTH_LOGIN_FAILURE:username_conflict',
    );
  });

  it('leaves no trace of forged or expired tokens', async () => {
    const before = (await auditRows()).length;
    const forged = await new SignJWT({ sub: 'x', azp: desktop.clientId })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .sign((await generateKeyPair('ES256')).privateKey);
    expect((await me(forged)).statusCode).toBe(401);
    expect(
      (await me(await token('sub-dana', 'dana', { iat: nowSec() - 600, exp: nowSec() - 60 }))).statusCode,
    ).toBe(401);
    expect(await auditRows()).toHaveLength(before);
  });

  it('keeps the audit chain intact', async () => {
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });
  });
});
