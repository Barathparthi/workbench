import { DomainError } from '@qe/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { verifyAuditChain, writeAuditEvent } from '../audit/audit-writer.js';
import { loadMigrations, migrate, MigrationError, migrationsUpToDate } from '../db/migrator.js';
import { createPool, pingDatabase } from '../db/pool.js';
import { MembersRepo } from '../repos/members.js';
import { TemplatesRepo } from '../repos/templates.js';
import { UsersRepo } from '../repos/users.js';
import { isUniqueViolation, WorkspacesRepo } from '../repos/workspaces.js';
import { appUrl, startTestDatabase, type TestDatabase } from './postgres.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await startTestDatabase();
});

afterAll(async () => {
  await t.stop();
});

const newUser = (name: string) =>
  new UsersRepo(t.db).upsertIdentity({ issuer: 'test', subject: name, username: name, displayName: name });

const newWorkspace = async (ownerId: string, name: string) => {
  const repo = new WorkspacesRepo(t.db);
  const row = await repo.insert({
    id: uuidv7(),
    name,
    ownerId,
    templateId: 'tpl_python_pytest',
    runtimeKind: 'docker',
    resourceProfile: 'standard',
    gitUrl: null,
    gitRef: null,
  });
  await new MembersRepo(t.db).add(row.id, ownerId, 'owner');
  return row;
};

describe('migrations', () => {
  it('apply from empty and report up to date; a second run applies nothing', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.version)).toEqual(['0001', '0002', '0003']);
    expect(await migrationsUpToDate(t.adminPool, migrations)).toBe(true);
    expect(await migrate(t.adminPool, migrations)).toEqual([]);
  });

  it('refuse to run when an applied migration was edited', async () => {
    const [first, ...rest] = await loadMigrations();
    if (first === undefined) throw new Error('no migrations');
    const edited = { ...first, checksum: 'f'.repeat(64) };
    await expect(migrate(t.adminPool, [edited, ...rest])).rejects.toThrow(MigrationError);
    expect(await migrationsUpToDate(t.adminPool, [edited, ...rest])).toBe(false);
  });

  it('roll back a failing migration and leave nothing applied', async () => {
    const migrations = await loadMigrations();
    const broken = {
      version: '9999',
      name: 'broken',
      sql: 'CREATE TABLE half (id int); SELECT 1/0;',
      checksum: 'x',
    };
    await expect(migrate(t.adminPool, [...migrations, broken])).rejects.toThrow(/9999_broken failed/);
    const half = await t.adminPool.query("SELECT to_regclass('public.half') AS t");
    expect(half.rows[0]).toEqual({ t: null });
    expect(await migrationsUpToDate(t.adminPool, migrations)).toBe(true);
  });

  it('seed the two development templates', async () => {
    const templates = await new TemplatesRepo(t.db).listEnabled();
    expect(templates.map((x) => x.id).sort()).toEqual(['tpl_java_maven', 'tpl_python_pytest']);
  });
});

describe('repositories (as the application role)', () => {
  it('upsert a user once per identity', async () => {
    const a = await newUser('alice');
    expect(await newUser('alice')).toBe(a);
    expect((await new UsersRepo(t.db).findById(a))?.username).toBe('alice');
  });

  it('show a workspace only to its members and hide deleted ones', async () => {
    const owner = await newUser('owner1');
    const stranger = await newUser('stranger1');
    const ws = await newWorkspace(owner, 'visible-one');
    const repo = new WorkspacesRepo(t.db);
    expect((await repo.findVisible(ws.id, owner))?.member_role).toBe('owner');
    expect(await repo.findVisible(ws.id, stranger)).toBeUndefined();
    expect((await repo.listForUser(owner, 10)).map((w) => w.id)).toContain(ws.id);
    expect(await repo.listForUser(stranger, 10)).toEqual([]);
    expect(await new MembersRepo(t.db).roleOf(ws.id, stranger)).toBeUndefined();

    await repo.transition(ws.id, 'CREATED', 'DELETING');
    await repo.transition(ws.id, 'DELETING', 'DELETED');
    expect(await repo.findVisible(ws.id, owner)).toBeUndefined();
    expect(await repo.update(ws.id, { name: 'renamed' })).toBeUndefined();
  });

  it('enforce one live name per owner, and free the name when a workspace is deleted', async () => {
    const owner = await newUser('owner2');
    const first = await newWorkspace(owner, 'dup-name');
    const error = await newWorkspace(owner, 'dup-name').catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);

    const repo = new WorkspacesRepo(t.db);
    await repo.transition(first.id, 'CREATED', 'DELETING');
    await repo.transition(first.id, 'DELETING', 'DELETED');
    await expect(newWorkspace(owner, 'dup-name')).resolves.toMatchObject({ state: 'CREATED' });
  });

  it('update name and git source', async () => {
    const owner = await newUser('owner3');
    const ws = await newWorkspace(owner, 'to-update');
    const row = await new WorkspacesRepo(t.db).update(ws.id, {
      name: 'updated',
      gitUrl: 'https://git.example/repo.git',
      gitRef: 'dev',
    });
    expect(row).toMatchObject({ name: 'updated', git_url: 'https://git.example/repo.git', git_ref: 'dev' });
  });

  it('let exactly one of 20 concurrent state changes win (compare-and-set)', async () => {
    const owner = await newUser('owner4');
    const ws = await newWorkspace(owner, 'race');
    const repo = new WorkspacesRepo(t.db);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repo.transition(ws.id, 'CREATED', 'STARTING', 'race')),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const after = await repo.findVisible(ws.id, owner);
    expect(after).toMatchObject({ state: 'STARTING', state_version: 1 });
  });

  it('refuse an illegal transition before touching the database', async () => {
    const owner = await newUser('owner5');
    const ws = await newWorkspace(owner, 'illegal');
    await expect(new WorkspacesRepo(t.db).transition(ws.id, 'CREATED', 'RUNNING')).rejects.toThrow(
      DomainError,
    );
  });
});

describe('audit log', () => {
  const record = (name: string) =>
    t.db.transaction().execute((tx) =>
      writeAuditEvent(tx, {
        action: 'WORKSPACE_CREATE',
        actorType: 'user',
        actorUserId: null,
        resourceType: 'workspace',
        resourceId: uuidv7(),
        result: 'success',
        requestId: 'req-12345678',
        metadata: { name, templateId: 'tpl_python_pytest' },
      }),
    );

  it('chains concurrent writers into one verifiable chain', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => record(`chain-${String(i)}`)));
    const result = await verifyAuditChain(t.db);
    expect(result).toEqual({ ok: true, events: expect.any(Number) as number });
    expect(result.ok && result.events).toBeGreaterThanOrEqual(10);
  });

  it('rejects metadata outside the allowlist and writes nothing', async () => {
    const before = await t.db
      .selectFrom('audit_events')
      .select((e) => e.fn.countAll().as('n'))
      .executeTakeFirst();
    await expect(
      t.db.transaction().execute((tx) =>
        writeAuditEvent(tx, {
          action: 'WORKSPACE_DELETE',
          actorType: 'user',
          actorUserId: null,
          resourceType: 'workspace',
          resourceId: null,
          result: 'success',
          metadata: { name: 'x', password: 'hunter2' },
        }),
      ),
    ).rejects.toThrow(/not allowed/);
    const after = await t.db
      .selectFrom('audit_events')
      .select((e) => e.fn.countAll().as('n'))
      .executeTakeFirst();
    expect(after).toEqual(before);
  });

  it('cannot be updated, deleted or truncated by the application role', async () => {
    const id = await record('immutable');
    await expect(
      t.appPool.query("UPDATE audit_events SET result = 'denied' WHERE id = $1", [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(t.appPool.query('DELETE FROM audit_events WHERE id = $1', [id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(t.appPool.query('TRUNCATE audit_events')).rejects.toThrow(/permission denied/);
  });

  it('cannot be rewritten even by the table owner (append-only trigger)', async () => {
    const id = await record('owner-cannot-edit');
    await expect(
      t.adminPool.query("UPDATE audit_events SET result = 'denied' WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only/);
    await expect(t.adminPool.query('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
  });

  it('detects tampering', async () => {
    const id = await record('tampered');
    const client = await t.adminPool.connect();
    try {
      await client.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete');
      await client.query(
        `UPDATE audit_events SET metadata_json = '{"name":"forged","templateId":"tpl_python_pytest"}' WHERE id = $1`,
        [id],
      );
      await client.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete');
    } finally {
      client.release();
    }
    expect(await verifyAuditChain(t.db)).toEqual({ ok: false, brokenAt: id });
  });
});

describe('application role', () => {
  it('cannot change the schema or the migration history', async () => {
    await expect(t.appPool.query('CREATE TABLE intruder (id int)')).rejects.toThrow(/permission denied/);
    await expect(t.appPool.query('DROP TABLE workspaces')).rejects.toThrow(/must be owner/);
    await expect(t.appPool.query("DELETE FROM schema_migrations WHERE version = '0002'")).rejects.toThrow(
      /permission denied/,
    );
  });

  it('runs with server-side statement timeouts', async () => {
    await pingDatabase(t.db);
    const { rows } = await t.appPool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    expect(rows[0]?.statement_timeout).toBe('5s');
  });

  it('survives the server terminating an idle connection, and reconnects', async () => {
    const errors: (Error & { code?: string })[] = [];
    const pool = createPool(appUrl(t.container), 1, (error) => errors.push(error));
    try {
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await t.adminPool.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
      await vi.waitFor(() => {
        expect(errors.map((e) => e.code)).toEqual(['57P01']);
      });
      await expect(pool.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    } finally {
      await pool.end();
    }
  });
});
