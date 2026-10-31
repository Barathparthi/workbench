/** Remote test runs on PostgreSQL (PHASE_11 §11.4): runs ride on exec sessions the broker carries out. */
import type { RemoteTestRunResponse } from '@qe/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makePrincipal, type Principal } from '../auth.js';
import { createRemoteSessionService, type RemoteSessionService } from '../remote-session-service.js';
import { UsersRepo } from '../repos/users.js';
import { buildServer } from '../server.js';
import { createTargetService, type TargetService } from '../target-service.js';
import { createTestRunService, type TestRunService } from '../test-run-service.js';
import { createWorkspaceService } from '../workspace-service.js';
import { fakeHealth, logSink, testConfig } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

const ORIGIN = 'https://qe.example';
const FP = `SHA256:${'A'.repeat(43)}`;

let t: TestDatabase;
let targets: TargetService;
let sessions: RemoteSessionService;
let runs: TestRunService;
let admin: Principal;
let bob: Principal; // a lab A user
let carol: Principal; // a QE user without the lab role
let execTarget = '';
let terminalOnlyTarget = '';
const brokerCloses: string[] = [];
const app: FastifyInstance[] = [];
const ctx = (p: Principal) => ({ principal: p, requestId: 'req-remote-runs' });

const user = async (name: string, roles: string[]) =>
  makePrincipal({
    userId: await new UsersRepo(t.db).upsertIdentity({
      issuer: 'test',
      subject: name,
      username: name,
      displayName: name,
    }),
    username: name,
    roles,
  });

const audit = async (resourceId: string) =>
  t.db
    .selectFrom('audit_events')
    .select(['action', 'result', 'actor_type', 'actor_user_id', 'metadata_json'])
    .where('resource_id', '=', resourceId)
    .orderBy('seq')
    .execute();

async function target(name: string, host: string, capabilities: ('terminal' | 'exec')[]): Promise<string> {
  const policy = await targets.createPolicy(ctx(admin), {
    name: `${name}-policy`,
    allowedRoles: ['lab.a.user'],
    allowedCidrs: ['10.20.0.0/16'],
    allowedPorts: [22],
    capabilities,
    idleTimeoutSec: 1800,
    maxSessionSec: 3600,
    maxSessionsPerUser: 5,
  });
  const registered = await targets.registerTarget(ctx(admin), {
    name,
    host,
    port: 22,
    os: 'linux',
    principalTemplate: 'qeauto',
    remoteRoot: '/srv/qe',
    policyId: policy.id,
    tags: [],
  });
  await targets.addHostKey(ctx(admin), registered.id, { algorithm: 'ssh-ed25519', fingerprintSha256: FP });
  const cred = await targets.createCredentialRef(ctx(admin), {
    provider: 'vault',
    method: 'ssh_certificate',
    providerPath: `ssh-client-signer/sign/${name}`,
    metadata: { ttl: '10m' },
  });
  await targets.updateTarget(ctx(admin), registered.id, { credentialRefId: cred.id, status: 'active' });
  return registered.id;
}

const start = (p: Principal, targetId = execTarget, selector = { kind: 'all' as const }) =>
  runs.startRemote(ctx(p), targetId, { framework: 'pytest', selector }, ORIGIN);

const brokerResult = (run: RemoteTestRunResponse, over: object = {}) => ({
  sessionId: run.session.sessionId,
  state: 'FAILED' as const,
  exitCode: 1,
  durationMs: 2100,
  counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 },
  failures: [
    {
      id: 'tests.test_calculator::t',
      name: 't',
      status: 'failed' as const,
      file: 'tests/test_calculator.py',
      line: 21,
    },
  ],
  truncated: false,
  artifacts: [
    {
      kind: 'junit_xml' as const,
      path: `.qe-runs/${run.run.id}/junit.xml`,
      sizeBytes: 1500,
      sha256: 'a'.repeat(64),
    },
  ],
  ...over,
});

beforeAll(async () => {
  t = await startTestDatabase();
  [admin, bob, carol] = await Promise.all([
    user('admin', ['qe.admin', 'qe.user']),
    user('bob', ['qe.user', 'lab.a.user']),
    user('carol', ['qe.user']),
  ]);
  targets = createTargetService(t.db, {
    deniedCidrs: [],
    resolver: () => Promise.reject(new Error('IP only')),
  });
  sessions = createRemoteSessionService(t.db, {
    ticketTtlMs: 60_000,
    allowedOrigins: [ORIGIN],
    closeOnBroker: (sessionId) => {
      brokerCloses.push(sessionId);
      return Promise.resolve();
    },
  });
  runs = createTestRunService(t.db, sessions);
  execTarget = await target('lab-exec', '10.20.1.5', ['terminal', 'exec']);
  terminalOnlyTarget = await target('lab-terminal', '10.20.1.6', ['terminal']);
});

afterAll(async () => {
  await Promise.all(app.map((a) => a.close()));
  await t.stop();
});

describe('remote test runs', () => {
  it('records the run with its exec session; the broker gets the run, never a command line', async () => {
    const started = await start(bob, execTarget, { kind: 'file', path: 'tests/test_calculator.py' } as never);
    expect(started.run).toMatchObject({
      targetId: execTarget,
      workspaceId: null,
      userId: bob.userId,
      state: 'RUNNING',
      selector: { kind: 'file', path: 'tests/test_calculator.py' },
    });
    expect(started.session.ticket.length).toBeGreaterThan(20);
    const snapshot = await sessions.redeem(started.session.ticket, ORIGIN);
    expect(snapshot).toMatchObject({
      kind: 'exec',
      testRun: {
        runId: started.run.id,
        framework: 'pytest',
        selector: { kind: 'file', path: 'tests/test_calculator.py' },
      },
      target: { remoteRoot: '/srv/qe' },
    });
    const events = await audit(started.run.id);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'QE_TEST_STARTED',
        metadata_json: { targetId: execTarget, framework: 'pytest', selectorKind: 'file' },
      }),
    ]);
  });

  it('applies the policy: no lab role, no target (404); no exec capability, refused and audited; nothing recorded', async () => {
    await expect(start(carol)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(start(bob, terminalOnlyTarget)).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
    const denied = await t.db
      .selectFrom('audit_events')
      .select(['action', 'reason_code'])
      .where('action', '=', 'REMOTE_CONNECT_DENIED')
      .where('resource_id', '=', terminalOnlyTarget)
      .execute();
    expect(denied).toEqual([{ action: 'REMOTE_CONNECT_DENIED', reason_code: 'capability_not_allowed' }]);
    const recorded = await t.db
      .selectFrom('test_runs')
      .select('id')
      .where('target_id', '=', terminalOnlyTarget)
      .execute();
    expect(recorded).toEqual([]);
  });

  it('shows a run outside a workspace to its user only', async () => {
    const started = await start(bob);
    expect((await runs.get(ctx(bob), started.run.id)).id).toBe(started.run.id);
    expect((await runs.list(ctx(bob), undefined, 50)).map((r) => r.id)).toContain(started.run.id);
    await expect(runs.get(ctx(carol), started.run.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await runs.list(ctx(carol), undefined, 50)).toEqual([]);
  });

  it('takes the result from the broker only, once, from the session that carries the run', async () => {
    const started = await start(bob);
    await expect(runs.finish(ctx(bob), started.run.id, brokerResult(started))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      runs.finishFromBroker(
        started.run.id,
        brokerResult(started, { sessionId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const finished = await runs.finishFromBroker(started.run.id, brokerResult(started));
    expect(finished).toMatchObject({
      state: 'FAILED',
      counts: { total: 5, failed: 1 },
      failures: [{ line: 21 }],
      artifacts: [{ kind: 'junit_xml', sizeBytes: 1500 }],
    });
    await expect(runs.finishFromBroker(started.run.id, brokerResult(started))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await audit(started.run.id)).at(-1)).toMatchObject({
      action: 'QE_TEST_FINISHED',
      actor_type: 'service',
      actor_user_id: bob.userId,
    });
  });

  it('cancels by closing the exec session; the session’s end records the run CANCELLED if the broker did not', async () => {
    const started = await start(bob);
    await sessions.redeem(started.session.ticket, ORIGIN);
    await sessions.reportState(started.session.sessionId, {
      state: 'ACTIVE',
      reason: 'opened',
      brokerInstance: 'b1',
    });
    await expect(runs.cancel(ctx(carol), started.run.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await runs.cancel(ctx(bob), started.run.id);
    expect(brokerCloses).toContain(started.session.sessionId);
    await sessions.reportState(started.session.sessionId, {
      state: 'CLOSED',
      reason: 'client_closed',
      brokerInstance: 'b1',
    });
    expect(await runs.get(ctx(bob), started.run.id)).toMatchObject({ state: 'CANCELLED' });
    expect((await audit(started.run.id)).map((e) => e.action)).toEqual([
      'QE_TEST_STARTED',
      'QE_TEST_CANCELLED',
    ]);
  });

  it('records the run as an error when its session could not connect', async () => {
    const started = await start(bob);
    await sessions.redeem(started.session.ticket, ORIGIN);
    await sessions.reportState(started.session.sessionId, {
      state: 'FAILED',
      reason: 'HOST_KEY_MISMATCH',
      brokerInstance: 'b1',
    });
    expect(await runs.get(ctx(bob), started.run.id)).toMatchObject({ state: 'ERROR' });
    expect((await audit(started.run.id)).at(-1)).toMatchObject({
      action: 'QE_TEST_FINISHED',
      result: 'failure',
    });
  });

  it('never gives the broker an exec session without a run', async () => {
    const bare = await sessions.open(ctx(bob), execTarget, { kind: 'exec' }, ORIGIN);
    await expect(sessions.redeem(bare.ticket, ORIGIN)).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
    // And the API does not open one: exec sessions come with test runs only.
    const server = await buildServer(testConfig(), {
      workspaces: createWorkspaceService(t.db, 'docker'),
      remote: { targets, sessions },
      testRuns: runs,
      devPrincipal: bob,
      logStream: logSink().stream,
      health: fakeHealth(),
    });
    app.push(server);
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/targets/${execTarget}/sessions`,
      headers: { origin: ORIGIN },
      payload: { kind: 'exec' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_REQUEST', details: { field: 'kind' } });
  });
});
