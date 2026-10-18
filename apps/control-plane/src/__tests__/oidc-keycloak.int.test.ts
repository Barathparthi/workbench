/**
 * Full OIDC login against a real Keycloak (the compose dev realm): authorization code + PKCE, ID-token
 * validation, group → role mapping, session cookie. Drives Keycloak's login form over plain HTTP.
 */
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openIdProvider } from '../auth/oidc.js';
import { createSessionAuth } from '../auth/session-auth.js';
import { loadConfig, oidcSettings } from '../config.js';
import { buildServer } from '../server.js';
import { createWorkspaceService } from '../workspace-service.js';
import { fakeHealth, logSink } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

/** Same image as deploy/compose/docker-compose.dev.yml. */
const KEYCLOAK_IMAGE =
  'quay.io/keycloak/keycloak:26.8.1@sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244';
const REALM_FILE = fileURLToPath(
  new URL('../../../../deploy/compose/keycloak/realm-qe.json', import.meta.url),
);

let keycloak: StartedTestContainer;
let t: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  [keycloak, t] = await Promise.all([
    new GenericContainer(KEYCLOAK_IMAGE)
      .withCommand(['start-dev', '--import-realm'])
      .withCopyFilesToContainer([{ source: REALM_FILE, target: '/opt/keycloak/data/import/realm-qe.json' }])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp('/realms/qe/.well-known/openid-configuration', 8080).forStatusCode(200))
      .withStartupTimeout(180_000)
      .start(),
    startTestDatabase(),
  ]);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused@localhost/qews',
    PUBLIC_ORIGIN: 'http://localhost:3000',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: `http://${keycloak.getHost()}:${String(keycloak.getMappedPort(8080))}/realms/qe`,
    OIDC_CLIENT_ID: 'qe-workspace',
    OIDC_CLIENT_SECRET: 'dev-only-qe-workspace-client-secret',
    OIDC_REDIRECT_URL: 'http://localhost:8080/auth/callback',
    ROLE_MAPPINGS: '{"qe-workspace-users":["qe.user"],"qe-lab-a":["lab.a.user"]}',
    SESSION_SECRET: 'integration-test-session-secret-0123456789',
    COOKIE_SECURE: 'false',
  });
  const settings = oidcSettings(config);
  app = await buildServer(config, {
    workspaces: createWorkspaceService(t.db, 'docker'),
    health: fakeHealth(),
    logStream: logSink().stream,
    sessions: {
      auth: createSessionAuth(t.db, openIdProvider(settings), settings),
      redirectUrl: settings.redirectUrl,
      publicOrigin: settings.publicOrigin,
      cookieSecure: false,
      cookieSecret: settings.sessionSecret,
    },
  });
}, 240_000);

afterAll(async () => {
  await app.close();
  await Promise.all([t.stop(), keycloak.stop()]);
});

/** Keeps Keycloak's cookies between requests, like a browser would. */
function cookieJar() {
  const jar = new Map<string, string>();
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    store: (res: Response) => {
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const eq = pair?.indexOf('=') ?? -1;
        if (pair !== undefined && eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
  };
}

/** Runs /auth/login → Keycloak form → /auth/callback; returns the callback response. */
async function signIn(username: string, password: string) {
  const start = await app.inject({ url: '/auth/login?returnTo=/w/x/' });
  expect(start.statusCode).toBe(302);
  const authUrl = start.headers.location as string;
  expect(new URL(authUrl).searchParams.get('code_challenge_method')).toBe('S256');
  const tx = start.cookies.find((c) => c.name === 'qews_oidc')?.value ?? '';

  const jar = cookieJar();
  const page = await fetch(authUrl, { redirect: 'manual' });
  jar.store(page);
  const html = await page.text();
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/
    .exec(html)?.[1]
    ?.replaceAll('&amp;', '&');
  if (action === undefined) throw new Error('Keycloak login form not found');

  const posted = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  const location = posted.headers.get('location');
  if (posted.status !== 302 || location === null) return { rejectedByIdp: true as const };
  const callback = new URL(location);
  expect(callback.origin + callback.pathname).toBe('http://localhost:8080/auth/callback');
  const res = await app.inject({
    url: `/auth/callback${callback.search}`,
    headers: { cookie: `qews_oidc=${tx}` },
  });
  return { rejectedByIdp: false as const, res, query: callback.search, tx };
}

describe('OIDC login against Keycloak', () => {
  it('signs bob in with roles from his groups', async () => {
    const result = await signIn('bob', 'dev-bob');
    if (result.rejectedByIdp) throw new Error('Keycloak rejected the login');
    expect(result.res.statusCode).toBe(303);
    expect(result.res.headers.location).toBe('http://localhost:3000/w/x/');
    const session = result.res.cookies.find((c) => c.name === 'qews_session')?.value ?? '';
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie: `qews_session=${session}` } });
    expect(me.json()).toMatchObject({
      username: 'bob',
      email: 'bob@qe.test',
      roles: ['lab.a.user', 'qe.user'],
    });
  });

  it('never gets past Keycloak with a wrong password', async () => {
    expect((await signIn('bob', 'wrong')).rejectedByIdp).toBe(true);
  });

  it('refuses to redeem the same authorization code twice', async () => {
    const first = await signIn('alice', 'dev-alice');
    if (first.rejectedByIdp) throw new Error('Keycloak rejected the login');
    expect(first.res.statusCode).toBe(303);
    const replay = await app.inject({
      url: `/auth/callback${first.query}`,
      headers: { cookie: `qews_oidc=${first.tx}` },
    });
    expect(replay.statusCode).toBe(401);
  });
});
