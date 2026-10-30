import type { TestRun, Workspace } from '@qe/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../audit/audit-writer.js';
import { makePrincipal, type Principal } from '../auth.js';
import { MembersRepo } from '../repos/members.js';
import { UsersRepo } from '../repos/users.js';
import { buildServer } from '../server.js';
import { createTestRunService } from '../test-run-service.js';
import { createWorkspaceService } from '../workspace-service.js';
import { fakeHealth, logSink, testConfig } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

let t: TestDatabase;
let owner: Principal;
let editor: Principal;
let viewer: Principal;
let stranger: Principal;
let workspace: Workspace;
const apps: FastifyInstance[] = [];

async function as(principal: Principal): Promise<FastifyInstance> {
  const app = await buildServer(testConfig(), {
    workspaces: createWorkspaceService(t.db, 'docker'),
    testRuns: createTestRunService(t.db),
    devPrincipal: principal,
    logStream: logSink().stream,
    health: fakeHealth(),
  });
  apps.push(app);
  return app;
}

const user = async (name: string): Promise<Principal> =>
  makePrincipal({
    userId: await new UsersRepo(t.db).upsertIdentity({
      issuer: 'test',
      subject: name,
      username: name,
      displayName: name,
    }),
    username: name,
    roles: ['qe.user'],
  });

const result = (runId: string, over: object = {}) => ({
  state: 'FAILED',
  exitCode: 1,
  durationMs: 1234,
  counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 },
  failures: [
    {
      id: 'tests.test_calculator::test_add_negative_fails_on_purpose',
      name: 'test_add_negative_fails_on_purpose',
      status: 'failed',
      file: 'tests/test_calculator.py',
      line: 21,
      message: 'assert -5 == -6',
    },
  ],
  truncated: false,
  artifacts: [
    { kind: 'junit_xml', path: `.qe-runs/${runId}/junit.xml`, sizeBytes: 1520, sha256: 'a'.repeat(64) },
    { kind: 'log', path: `.qe-runs/${runId}/output.log`, sizeBytes: 812, sha256: 'b'.repeat(64) },
  ],
  ...over,
});

beforeAll(async () => {
  t = await startTestDatabase();
  [owner, editor, viewer, stranger] = await Promise.all([
    user('owner'),
    user('editor'),
    user('viewer'),
    user('stranger'),
  ]);
  const created = await (
    await as(owner)
  ).inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    payload: { name: 'runs', templateId: 'tpl_python_pytest' },
  });
  workspace = created.json<Workspace>();
  await new MembersRepo(t.db).add(workspace.id, editor.userId, 'editor');
  await new MembersRepo(t.db).add(workspace.id, viewer.userId, 'viewer');
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await t.stop();
});

describe('test run records on a real database', () => {
  it('records a run, finishes it once, and lists it for the workspace’s members only', async () => {
    const asOwner = await as(owner);
    const started = await asOwner.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace.id}/test-runs`,
      payload: { framework: 'pytest', selector: { kind: 'file', path: 'tests/test_calculator.py' } },
    });
    expect(started.statusCode).toBe(201);
    const run = started.json<TestRun>();
    expect(run).toMatchObject({
      workspaceId: workspace.id,
      targetId: null,
      userId: owner.userId,
      framework: 'pytest',
      selector: { kind: 'file', path: 'tests/test_calculator.py' },
      state: 'RUNNING',
      counts: null,
      failures: [],
      artifacts: [],
      finishedAt: null,
    });

    const finished = await asOwner.inject({
      method: 'POST',
      url: `/api/v1/test-runs/${run.id}/result`,
      payload: result(run.id),
    });
    expect(finished.statusCode).toBe(200);
    expect(finished.json<TestRun>()).toMatchObject({
      state: 'FAILED',
      exitCode: 1,
      counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 },
      failures: [{ file: 'tests/test_calculator.py', line: 21 }],
      artifacts: [
        { kind: 'junit_xml', path: `.qe-runs/${run.id}/junit.xml`, sizeBytes: 1520 },
        { kind: 'log', sizeBytes: 812 },
      ],
    });

    const again = await asOwner.inject({
      method: 'POST',
      url: `/api/v1/test-runs/${run.id}/result`,
      payload: result(run.id),
    });
    expect(again.statusCode).toBe(409);

    for (const member of [owner, editor, viewer]) {
      const app = await as(member);
      expect((await app.inject({ url: `/api/v1/test-runs/${run.id}` })).json<TestRun>().state).toBe('FAILED');
      const list = await app.inject({ url: `/api/v1/test-runs?workspaceId=${workspace.id}` });
      expect(list.json<{ items: TestRun[] }>().items.map((r) => r.id)).toContain(run.id);
    }
    const asStranger = await as(stranger);
    expect((await asStranger.inject({ url: `/api/v1/test-runs/${run.id}` })).statusCode).toBe(404);
    expect(
      (await asStranger.inject({ url: `/api/v1/test-runs?workspaceId=${workspace.id}` })).statusCode,
    ).toBe(404);
  });

  it('lets editors record runs, not viewers or strangers, and only the starter finish one', async () => {
    const post = async (principal: Principal) =>
      (await as(principal)).inject({
        method: 'POST',
        url: `/api/v1/workspaces/${workspace.id}/test-runs`,
        payload: { framework: 'pytest', selector: { kind: 'all' } },
      });
    expect((await post(viewer)).statusCode).toBe(403);
    expect((await post(stranger)).statusCode).toBe(404);
    const byEditor = await post(editor);
    expect(byEditor.statusCode).toBe(201);
    const run = byEditor.json<TestRun>();
    const finish = async (principal: Principal) =>
      (await as(principal)).inject({
        method: 'POST',
        url: `/api/v1/test-runs/${run.id}/result`,
        payload: result(run.id),
      });
    expect((await finish(owner)).statusCode).toBe(403);
    expect((await finish(stranger)).statusCode).toBe(404);
    expect((await finish(editor)).statusCode).toBe(200);
  });

  it('refuses results that do not add up or point outside the run’s folder', async () => {
    const app = await as(owner);
    const run = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${workspace.id}/test-runs`,
        payload: { framework: 'pytest', selector: { kind: 'all' } },
      })
    ).json<TestRun>();
    const send = (payload: object) =>
      app.inject({ method: 'POST', url: `/api/v1/test-runs/${run.id}/result`, payload });
    expect(
      (await send(result(run.id, { counts: { total: 9, passed: 3, failed: 1, errors: 0, skipped: 1 } })))
        .statusCode,
    ).toBe(400);
    const other = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
    for (const path of [`.qe-runs/${other}/junit.xml`, `.qe-runs/${run.id}/../../.ssh/id_rsa`, '/etc/passwd'])
      expect(
        (
          await send(
            result(run.id, { artifacts: [{ kind: 'other', path, sizeBytes: 1, sha256: 'c'.repeat(64) }] }),
          )
        ).statusCode,
      ).toBe(400);
    expect((await send(result(run.id, { state: 'RUNNING' }))).statusCode).toBe(400);
    // Still RUNNING: nothing was recorded.
    expect((await app.inject({ url: `/api/v1/test-runs/${run.id}` })).json<TestRun>().state).toBe('RUNNING');
    const cancelled = await send(
      result(run.id, {
        state: 'CANCELLED',
        exitCode: undefined,
        counts: { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 },
        failures: [],
        artifacts: [],
      }),
    );
    expect(cancelled.json<TestRun>()).toMatchObject({ state: 'CANCELLED', exitCode: null });
  });

  it('audits start, finish and cancel with counts only — no paths or test names — on an intact chain', async () => {
    const events = await t.db
      .selectFrom('audit_events')
      .select(['action', 'result', 'resource_type', 'metadata_json'])
      .where('action', 'like', 'QE_TEST_%')
      .orderBy('seq')
      .execute();
    expect(events.map((e) => e.action)).toEqual([
      'QE_TEST_STARTED',
      'QE_TEST_FINISHED',
      'QE_TEST_STARTED',
      'QE_TEST_FINISHED',
      'QE_TEST_STARTED',
      'QE_TEST_CANCELLED',
    ]);
    expect(events[0]).toMatchObject({
      resource_type: 'test_run',
      result: 'success',
      metadata_json: { workspaceId: workspace.id, framework: 'pytest', selectorKind: 'file' },
    });
    expect(events[1]?.metadata_json).toEqual({
      state: 'FAILED',
      exitCode: 1,
      durationMs: 1234,
      total: 5,
      passed: 3,
      failed: 1,
      errors: 0,
      skipped: 1,
    });
    expect(JSON.stringify(events)).not.toMatch(/test_calculator|assert|\.qe-runs/);
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });
  });
});
