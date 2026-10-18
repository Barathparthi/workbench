/** Session lifecycle against a real PostgreSQL with a fake IdP (Keycloak itself: oidc-keycloak.int.test.ts). */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../audit/audit-writer.js';
import type { OidcIdentity, OidcProvider } from '../auth/oidc.js';
import { LoginError } from '../auth/oidc.js';
import { createSessionAuth } from '../auth/session-auth.js';
import { oidcSettings } from '../config.js';
import { UsersRepo } from '../repos/users.js';
import { buildServer } from '../server.js';
import { createWorkspaceService } from '../workspace-service.js';
import { fakeHealth, logSink, testConfig } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

let t: TestDatabase;
let clock = new Date('2026-10-18T09:00:00Z');
let identity: OidcIdentity;
let exchangeError: Error | undefined;

const config = testConfig({
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://idp.test/realms/qe',
  OIDC_CLIENT_ID: 'qe-workspace',
  OIDC_CLIENT_SECRET: 'test-secret',
  OIDC_REDIRECT_URL: 'https://qe.example/auth/callback',
  SESSION_SECRET: 'x'.repeat(40),
  ROLE_MAPPINGS: { 'qe-users': ['qe.user'], 'qe-lab-a': ['lab.a.user'], 'qe-auditors': ['auditor'] },
});
const settings = oidcSettings(config);

const fakeIdp: OidcProvider = {
  authorizationUrl: () => Promise.resolve('https://idp.test/auth'),
  exchange: () => (exchangeError === undefined ? Promise.resolve(identity) : Promise.reject(exchangeError)),
};

let app: FastifyInstance;

async function login(): Promise<{ session: string; csrf: string; status: number }> {
  const start = await app.inject({ url: '/auth/login?returnTo=/w/1/' });
  const tx = start.cookies.find((c) => c.name === 'qews_oidc');
  const res = await app.inject({
    url: '/auth/callback?code=c&state=s',
    headers: { cookie: `qews_oidc=${tx?.value ?? ''}` },
  });
  return {
    status: res.statusCode,
    session: res.cookies.find((c) => c.name === 'qews_session')?.value ?? '',
    csrf: res.cookies.find((c) => c.name === 'qews_csrf')?.value ?? '',
  };
}
const me = (session: string) =>
  app.inject({ url: '/api/v1/me', headers: { cookie: `qews_session=${session}` } });
const auditActions = async () =>
  (await t.db.selectFrom('audit_events').select(['action', 'reason_code']).orderBy('seq').execute()).map(
    (r) => `${r.action}${r.reason_code ? `:${r.reason_code}` : ''}`,
  );

beforeAll(async () => {
  t = await startTestDatabase();
  app = await buildServer(config, {
    workspaces: createWorkspaceService(t.db, 'docker'),
    health: fakeHealth(),
    logStream: logSink().stream,
    sessions: {
      auth: createSessionAuth(t.db, fakeIdp, settings, () => clock),
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

describe('OIDC session lifecycle (PostgreSQL)', () => {
  it('creates the user, maps groups to roles and stores only token hashes', async () => {
    identity = {
      issuer: 'https://idp.test/realms/qe',
      subject: 'sub-bob',
      username: 'bob',
      displayName: 'Bob',
      groups: ['qe-users', 'qe-lab-a', 'unmapped'],
    };
    const { status, session, csrf } = await login();
    expect(status).toBe(303);
    const body = (await me(session)).json<{ username: string; roles: string[] }>();
    expect(body).toMatchObject({ username: 'bob', roles: ['lab.a.user', 'qe.user'] });
    const rows = await t.adminPool.query<{ token_hash: Buffer }>('SELECT token_hash FROM web_sessions');
    const stored = rows.rows.map((r) => r.token_hash.toString('hex')).join();
    expect(stored).not.toContain(Buffer.from(session).toString('hex'));
    expect(csrf.length).toBeGreaterThan(30);
  });

  it('re-syncs IdP roles on the next login and keeps manual grants', async () => {
    const bob = await t.db
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'bob')
      .executeTakeFirstOrThrow();
    await t.adminPool.query(
      "INSERT INTO user_roles (user_id, role_id, source) SELECT $1, id, 'manual' FROM roles WHERE name = 'auditor'",
      [bob.id],
    );
    identity = { ...identity, groups: ['qe-users'] };
    const { session } = await login();
    expect((await me(session)).json<{ roles: string[] }>().roles).toEqual(['auditor', 'qe.user']);
  });

  it('expires idle sessions and audits it', async () => {
    const { session } = await login();
    clock = new Date(clock.getTime() + settings.idleMs + 1000);
    expect((await me(session)).statusCode).toBe(401);
    expect(await auditActions()).toContain('AUTH_SESSION_EXPIRED');
  });

  it('expires at the absolute limit even when active', async () => {
    const { session } = await login();
    for (let elapsed = 0; elapsed < settings.absoluteMs; elapsed += settings.idleMs / 2) {
      clock = new Date(clock.getTime() + settings.idleMs / 2);
      await me(session);
    }
    expect((await me(session)).statusCode).toBe(401);
  });

  it('ends all access when the user is disabled', async () => {
    const { session } = await login();
    const bob = await t.db
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'bob')
      .executeTakeFirstOrThrow();
    await new UsersRepo(t.db).setStatus(bob.id, 'disabled');
    expect((await me(session)).statusCode).toBe(401);
    expect((await login()).status).toBe(401);
    expect(await auditActions()).toContain('AUTH_LOGIN_FAILURE:user_disabled');
    await new UsersRepo(t.db).setStatus(bob.id, 'active');
  });

  it('logs out with the CSRF token only, once', async () => {
    const { session, csrf } = await login();
    const cookie = `qews_session=${session}`;
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode).toBe(
      403,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, 'x-csrf-token': csrf } }))
        .statusCode,
    ).toBe(204);
    expect((await me(session)).statusCode).toBe(401);
  });

  it('audits failed exchanges and username takeovers', async () => {
    exchangeError = new LoginError('token_exchange');
    expect((await login()).status).toBe(401);
    exchangeError = undefined;
    identity = {
      issuer: 'https://idp.test/realms/qe',
      subject: 'someone-else',
      username: 'bob',
      displayName: 'Mallory',
      groups: ['qe-users'],
    };
    expect((await login()).status).toBe(401);
    const actions = await auditActions();
    expect(actions).toContain('AUTH_LOGIN_FAILURE:token_exchange');
    expect(actions).toContain('AUTH_LOGIN_FAILURE:username_conflict');
  });

  it('audits denied privileged requests and keeps the audit chain intact', async () => {
    identity = {
      issuer: 'https://idp.test/realms/qe',
      subject: 'sub-carol',
      username: 'carol',
      displayName: 'Carol',
      groups: ['qe-auditors'],
    };
    const { session, csrf } = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie: `qews_session=${session}`, 'x-csrf-token': csrf, origin: 'https://qe.example' },
      payload: { name: 'nope', templateId: 'tpl_python_pytest' },
    });
    expect(res.statusCode).toBe(403);
    expect(await auditActions()).toContain('ACCESS_DENIED:missing_permission');
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });
  });
});
