import { DomainError } from '@qe/domain';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { devPrincipal, fakeHealth, fakeWorkspaces, logSink, testConfig } from './fixtures.js';

const WS_ID = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';

describe('problem+json errors', () => {
  it('maps DomainError to its status and code, with the request id', async () => {
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces({ get: () => Promise.reject(new DomainError('NOT_FOUND')) }),
      health: fakeHealth(),
      devPrincipal,
    });
    const res = await app.inject({
      url: `/api/v1/workspaces/${WS_ID}`,
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['x-request-id']).toBe('req-12345678');
    expect(res.json()).toEqual({
      type: 'https://qe-workspace.corp/errors/NOT_FOUND',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      requestId: 'req-12345678',
    });
  });

  it('reports schema violations as INVALID_REQUEST with the issues, not the input', async () => {
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces(),
      health: fakeHealth(),
      devPrincipal,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { name: 'BAD NAME', templateId: 'tpl_x' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string; details: { location: string; issues: { path: string }[] } }>();
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.details.location).toBe('body');
    expect(body.details.issues[0]?.path).toBe('/name');
    expect(res.body).not.toContain('BAD NAME');
  });

  it('answers unexpected errors with INTERNAL_ERROR and no stack, logging the detail server-side', async () => {
    const logs = logSink();
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces({
        list: () => Promise.reject(new Error('db exploded at /srv/secret/path')),
      }),
      health: fakeHealth(),
      devPrincipal,
      logStream: logs.stream,
    });
    const res = await app.inject({ url: '/api/v1/workspaces' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR', title: 'Internal error' });
    expect(res.body).not.toMatch(/exploded|stack|\/srv/);
    expect(logs.text()).toContain('db exploded');
  });

  it('turns unknown routes, oversized bodies and bad JSON into problems', async () => {
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces(),
      health: fakeHealth(),
      devPrincipal,
    });
    expect((await app.inject({ url: '/api/v1/nope' })).json()).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    const big = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: `{"name":"${'a'.repeat(1024 * 1024)}"}`,
    });
    expect(big.json()).toMatchObject({ status: 413, code: 'INVALID_REQUEST' });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.json()).toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
  });
});

describe('authentication before Phase 04', () => {
  it('fails closed in oidc mode: protected routes answer 401, public ones still work', async () => {
    const app = await buildServer(testConfig({ AUTH_MODE: 'oidc' }), {
      workspaces: fakeWorkspaces(),
      health: fakeHealth(),
    });
    expect((await app.inject({ url: '/api/v1/workspaces' })).json()).toMatchObject({
      status: 401,
      code: 'AUTH_REQUIRED',
    });
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${WS_ID}` })).statusCode).toBe(401);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    // Unknown paths are not public either: no route enumeration without a session.
    expect((await app.inject({ url: '/api/v1/nothing-here' })).statusCode).toBe(401);
  });

  it('acts as the dev principal in dev mode', async () => {
    let seen: string | undefined;
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces({
        list: (ctx) => {
          seen = ctx.principal.userId;
          return Promise.resolve([]);
        },
      }),
      health: fakeHealth(),
      devPrincipal,
    });
    expect((await app.inject({ url: '/api/v1/workspaces' })).json()).toEqual({ items: [] });
    expect(seen).toBe(devPrincipal.userId);
  });
});

describe('origin check', () => {
  const create = (app: Awaited<ReturnType<typeof buildServer>>, origin?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: origin === undefined ? {} : { origin },
      payload: { name: 'from-origin', templateId: 'tpl_python_pytest' },
    });

  it('refuses unsafe requests from an origin outside the allowlist, before any work is done', async () => {
    let created = 0;
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces({
        create: () => {
          created++;
          return Promise.reject(new DomainError('CONFLICT'));
        },
      }),
      health: fakeHealth(),
      devPrincipal,
    });
    const foreign = await create(app, 'https://evil.example');
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    expect((await create(app, 'null')).statusCode).toBe(403);
    expect(created).toBe(0);

    expect((await create(app, 'https://qe.example')).statusCode).toBe(409);
    expect((await create(app)).statusCode).toBe(409); // non-browser client: no Origin header
    expect(created).toBe(2);
    expect(
      (await app.inject({ url: '/healthz', headers: { origin: 'https://evil.example' } })).statusCode,
    ).toBe(200);
  });
});

describe('route declarations', () => {
  it('refuses a route without permission, audit flag or rate limit', async () => {
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces(),
      health: fakeHealth(),
      devPrincipal,
    });
    expect(() => app.get('/api/v1/undeclared', () => 'x')).toThrow('must declare config.permission');
    expect(() =>
      app.get('/api/v1/no-audit', { config: { permission: 'workspace:read' } }, () => 'x'),
    ).toThrow('must declare config.audit');
    expect(() =>
      app.get('/api/v1/no-limit', { config: { permission: 'workspace:read', audit: false } }, () => 'x'),
    ).toThrow('must declare config.rateLimit');
  });

  it('enforces the declared rate limit with a RATE_LIMITED problem', async () => {
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces(),
      health: fakeHealth(),
      devPrincipal,
    });
    app.get(
      '/api/v1/limited',
      { config: { permission: 'public', audit: false, rateLimit: { max: 1, timeWindow: '1 minute' } } },
      () => ({
        ok: true,
      }),
    );
    expect((await app.inject({ url: '/api/v1/limited' })).statusCode).toBe(200);
    const limited = await app.inject({ url: '/api/v1/limited' });
    expect(limited.json()).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('logging', () => {
  it('redacts credentials, cookies, tokens and tickets', async () => {
    const logs = logSink();
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces(),
      health: fakeHealth(),
      devPrincipal,
      logStream: logs.stream,
    });
    app.log.info({
      req: { headers: { authorization: 'Bearer canary-1', cookie: 'qews_session=canary-2' } },
      user: { password: 'canary-3', token: 'canary-4' },
      session: { ticket: 'canary-5', secret: 'canary-6' },
    });
    expect(logs.text()).toContain('[REDACTED]');
    expect(logs.text()).not.toMatch(/canary-\d/);
  });

  it('sets security headers', async () => {
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces(),
      health: fakeHealth(),
      devPrincipal,
    });
    const res = await app.inject({ url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});

describe('health', () => {
  it('reports liveness, readiness and version', async () => {
    let ready = true;
    const health = fakeHealth(() => (ready ? Promise.resolve() : Promise.reject(new Error('db down'))));
    const app = await buildServer(testConfig(), { workspaces: fakeWorkspaces(), health, devPrincipal });
    expect((await app.inject({ url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ url: '/readyz' })).json()).toEqual({ status: 'ready' });
    ready = false;
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(503);
    ready = true;
    health.state.shuttingDown = true;
    expect((await app.inject({ url: '/readyz' })).json()).toEqual({ status: 'shutting-down' });
    expect((await app.inject({ url: '/version' })).json()).toEqual({
      version: '1.2.3',
      commit: 'abc123',
      builtAt: '2026-10-18T00:00:00Z',
    });
  });
});
