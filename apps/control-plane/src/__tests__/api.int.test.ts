import type { Workspace } from '@qe/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../audit/audit-writer.js';
import type { Principal } from '../auth.js';
import { loadMigrations, migrationsUpToDate } from '../db/migrator.js';
import { pingDatabase } from '../db/pool.js';
import { MembersRepo } from '../repos/members.js';
import { UsersRepo } from '../repos/users.js';
import { buildServer } from '../server.js';
import { createWorkspaceService } from '../workspace-service.js';
import { fakeHealth, logSink, testConfig } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

let t: TestDatabase;
let owner: Principal;
let editor: Principal;
let stranger: Principal;
const apps: FastifyInstance[] = [];

/** One server per principal, all on the same database (dev auth stands in for OIDC until Phase 04). */
async function serverAs(principal: Principal): Promise<FastifyInstance> {
  const migrations = await loadMigrations();
  const app = await buildServer(testConfig(), {
    workspaces: createWorkspaceService(t.db, 'docker'),
    devPrincipal: principal,
    logStream: logSink().stream,
    health: {
      ...fakeHealth(),
      checkReady: async () => {
        await pingDatabase(t.db);
        if (!(await migrationsUpToDate(t.appPool, migrations))) throw new Error('migrations behind');
      },
    },
  });
  apps.push(app);
  return app;
}

const user = async (name: string): Promise<Principal> => ({
  userId: await new UsersRepo(t.db).upsertIdentity({
    issuer: 'test',
    subject: name,
    username: name,
    displayName: name,
  }),
  username: name,
});

beforeAll(async () => {
  t = await startTestDatabase();
  [owner, editor, stranger] = await Promise.all([user('owner'), user('editor'), user('stranger')]);
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await t.stop();
});

describe('workspace API on a real database', () => {
  it('is ready once the database answers and migrations are current', async () => {
    const app = await serverAs(owner);
    const res = await app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(200);
  });

  it('lists the seeded templates', async () => {
    const app = await serverAs(owner);
    const res = await app.inject({ url: '/api/v1/workspace-templates' });
    expect(res.json<{ items: { id: string }[] }>().items.map((x) => x.id)).toContain('tpl_python_pytest');
  });

  it('runs the create → read → update → delete lifecycle with audit events', async () => {
    const asOwner = await serverAs(owner);
    const asEditor = await serverAs(editor);
    const asStranger = await serverAs(stranger);

    const created = await asOwner.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { 'x-request-id': 'req-create-0001' },
      payload: {
        name: 'api-flow',
        templateId: 'tpl_python_pytest',
        git: { url: 'https://git.example/r.git', ref: 'main' },
      },
    });
    expect(created.statusCode).toBe(201);
    const ws = created.json<Workspace>();
    expect(ws).toMatchObject({
      name: 'api-flow',
      state: 'CREATED',
      ownerId: owner.userId,
      ideUrl: `/w/${ws.id}/`,
      resources: { profile: 'standard' },
      git: { url: 'https://git.example/r.git', ref: 'main' },
    });

    const duplicate = await asOwner.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { name: 'api-flow', templateId: 'tpl_python_pytest' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'CONFLICT', details: { field: 'name' } });

    const unknownTemplate = await asOwner.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { name: 'other', templateId: 'tpl_missing' },
    });
    expect(unknownTemplate.statusCode).toBe(400);

    // Not a member: the workspace does not exist for this user (404, never 403 — no enumeration).
    const url = `/api/v1/workspaces/${ws.id}`;
    const strangerCalls = [
      asStranger.inject({ method: 'GET', url }),
      asStranger.inject({ method: 'PATCH', url, payload: { name: 'stolen' } }),
      asStranger.inject({ method: 'DELETE', url }),
    ];
    for (const res of await Promise.all(strangerCalls)) expect(res.statusCode).toBe(404);
    expect((await asStranger.inject({ url: '/api/v1/workspaces' })).json()).toEqual({ items: [] });

    // An editor may change metadata but not delete.
    await new MembersRepo(t.db).add(ws.id, editor.userId, 'editor');
    const renamed = await asEditor.inject({
      method: 'PATCH',
      url,
      payload: { name: 'api-flow-renamed', git: null },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'api-flow-renamed', git: null });
    const editorDelete = await asEditor.inject({ method: 'DELETE', url });
    expect(editorDelete.statusCode).toBe(403);

    const listed = await asOwner.inject({ url: '/api/v1/workspaces?limit=10' });
    expect(listed.json<{ items: Workspace[] }>().items.map((w) => w.id)).toEqual([ws.id]);

    const deleted = await asOwner.inject({
      method: 'DELETE',
      url,
      headers: { 'x-request-id': 'req-delete-0001' },
    });
    expect(deleted.statusCode).toBe(204);
    expect((await asOwner.inject({ url })).statusCode).toBe(404);

    const events = await t.db
      .selectFrom('audit_events')
      .select(['action', 'actor_user_id', 'resource_id', 'request_id', 'result', 'metadata_json'])
      .where('resource_id', '=', ws.id)
      .orderBy('seq')
      .execute();
    expect(events).toEqual([
      {
        action: 'WORKSPACE_CREATE',
        actor_user_id: owner.userId,
        resource_id: ws.id,
        request_id: 'req-create-0001',
        result: 'success',
        metadata_json: { name: 'api-flow', templateId: 'tpl_python_pytest' },
      },
      {
        action: 'WORKSPACE_DELETE',
        actor_user_id: owner.userId,
        resource_id: ws.id,
        request_id: 'req-delete-0001',
        result: 'success',
        metadata_json: { name: 'api-flow-renamed' },
      },
    ]);
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });

    // The deleted workspace frees its name.
    const again = await asOwner.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { name: 'api-flow-renamed', templateId: 'tpl_java_maven', resources: { profile: 'large' } },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ resources: { profile: 'large' }, git: null });
  });

  it('refuses to delete a workspace that is not stopped', async () => {
    const app = await serverAs(owner);
    const ws = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        payload: { name: 'busy', templateId: 'tpl_java_maven' },
      })
    ).json<Workspace>();
    await t.adminPool.query("UPDATE workspaces SET state = 'RUNNING' WHERE id = $1", [ws.id]);
    const url = `/api/v1/workspaces/${ws.id}`;
    const res = await app.inject({ method: 'DELETE', url });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ url })).json()).toMatchObject({
      state: 'RUNNING',
    });
  });

  it('rolls the action back when the audit event cannot be written (fail closed)', async () => {
    const app = await serverAs(owner);
    await t.adminPool.query('REVOKE INSERT ON audit_events FROM qews_app');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        payload: { name: 'unaudited', templateId: 'tpl_java_maven' },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await t.adminPool.query('GRANT INSERT ON audit_events TO qews_app');
    }
    const rows = await t.db.selectFrom('workspaces').select('id').where('name', '=', 'unaudited').execute();
    expect(rows).toEqual([]);
  });
});
