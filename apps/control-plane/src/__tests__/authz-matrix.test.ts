/**
 * Authorization matrix (Phase 04 §4 tests, 11_TESTING_STRATEGY §5): every registered route × every persona.
 * A route whose permission a persona lacks must answer 403 (401 without a session); otherwise the request must
 * get past authorization. New routes are covered automatically.
 */
import { DomainError } from '@qe/domain';
import { permissionsFor } from '@qe/rbac';
import type { RouteOptions } from 'fastify';
import { describe, expect, it } from 'vitest';

import { makePrincipal, sha256, type AuthInput } from '../auth.js';
import type { SessionAuth } from '../auth/session-auth.js';
import type { RemoteSessionService } from '../remote-session-service.js';
import { buildServer } from '../server.js';
import type { TargetService } from '../target-service.js';
import { WorkspaceEvents, type WorkspaceLifecycle } from '../workspace-lifecycle.js';
import { fakeHealth, fakeWorkspaces, logSink, testConfig } from './fixtures.js';

const personas = ['qe.user', 'qe.lead', 'qe.admin', 'auditor', 'lab.a.user', 'no-role'] as const;
const CSRF = 'csrf';

const notFound = () => Promise.reject(new DomainError('NOT_FOUND'));
const auth: SessionAuth = {
  authenticate: (request: AuthInput) => {
    const persona = request.cookies.qews_session;
    if (persona === undefined || !(personas as readonly string[]).includes(persona))
      return Promise.resolve(undefined);
    const principal = makePrincipal({
      userId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d72',
      username: 'p',
      roles: [persona],
    });
    return Promise.resolve({
      kind: 'session',
      session: { principal, sessionId: 's', csrfHash: sha256(CSRF) },
    });
  },
  recordDenied: () => Promise.resolve(),
  startLogin: () =>
    Promise.resolve({
      redirectUrl: 'https://idp.example/',
      transaction: { state: 's', nonce: 'n', codeVerifier: 'v'.repeat(43), returnTo: '/', expiresAt: 0 },
    }),
  finishLogin: notFound,
  logout: () => Promise.resolve(),
};

const routes: RouteOptions[] = [];
const app = await buildServer(testConfig({ AUTH_MODE: 'oidc' }), {
  workspaces: fakeWorkspaces({
    list: notFound,
    get: notFound,
    create: notFound,
    update: notFound,
    remove: notFound,
    templates: notFound,
  }),
  health: fakeHealth(),
  logStream: logSink().stream,
  sessions: {
    auth,
    redirectUrl: 'https://qe.example/auth/callback',
    publicOrigin: 'https://qe.example',
    cookieSecure: true,
    cookieSecret: 'x'.repeat(32),
  },
  runtime: {
    lifecycle: {
      events: new WorkspaceEvents(),
      start: notFound,
      stop: notFound,
    } as unknown as WorkspaceLifecycle,
    lookup: () => Promise.resolve(undefined),
    touch: () => Promise.resolve(),
  },
  remote: {
    targets: new Proxy({}, { get: () => notFound }) as unknown as TargetService,
    sessions: new Proxy({}, { get: () => notFound }) as unknown as RemoteSessionService,
    files: { run: notFound },
  },
  testRuns: {
    create: notFound,
    finish: notFound,
    list: notFound,
    get: notFound,
    startRemote: notFound,
    finishFromBroker: notFound,
    cancel: notFound,
  },
  onRouteRegistered: (r) => routes.push(r),
});
await app.ready();

const cases = routes
  .filter((r) => r.method !== 'HEAD' && !r.url.startsWith('/documentation'))
  .flatMap((r) =>
    (Array.isArray(r.method) ? r.method : [r.method]).map((method) => ({
      method: String(method),
      url: r.url,
      permission: r.config?.permission,
    })),
  );

// `:param` becomes an id; `::` is Fastify's escape for a literal colon (e.g. `tickets::redeem`).
const concrete = (url: string) =>
  url.replace(/(?<!:):[a-zA-Z]+/g, '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f').replaceAll('::', ':');

describe('authorization matrix', () => {
  it('found the routes to check', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.every((c) => c.permission !== undefined)).toBe(true);
  });

  describe.each(cases)('$method $url ($permission)', ({ method, url, permission }) => {
    const inject = (cookie?: string) =>
      app.inject({
        method: method as 'GET',
        url: concrete(url),
        headers: {
          origin: 'https://qe.example',
          'x-csrf-token': CSRF,
          ...(cookie && { cookie: `qews_session=${cookie}` }),
        },
      });

    if (permission === 'internal') {
      it('refuses every browser session (service token only)', async () => {
        for (const persona of [undefined, ...personas]) expect((await inject(persona)).statusCode).toBe(401);
      });
      return;
    }

    if (permission === 'public') {
      it('is reachable without a session', async () => {
        expect([401, 403]).not.toContain((await inject()).statusCode);
      });
      return;
    }

    it('answers 401 without a session', async () => {
      expect((await inject()).statusCode).toBe(401);
    });

    it.each(personas)('as %s', async (persona) => {
      const allowed = permission === 'authenticated' || permissionsFor([persona]).has(permission as never);
      const res = await inject(persona);
      if (allowed) expect([401, 403]).not.toContain(res.statusCode);
      else expect(res.json()).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });
  });
});
