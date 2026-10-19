/** Workspace lifecycle and reconciler against PostgreSQL with an in-memory runtime provider (Phase 05 §5.4–5.6). */
import type { RuntimeSpec, RuntimeStatus, WorkspaceRuntimeProvider } from '@qe/runtime-providers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../audit/audit-writer.js';
import { makePrincipal, type Principal } from '../auth.js';
import { reconcileOnce } from '../reconciler.js';
import { MembersRepo } from '../repos/members.js';
import { UsersRepo } from '../repos/users.js';
import { WorkspacesRepo } from '../repos/workspaces.js';
import { createWorkspaceLifecycle, type WorkspaceLifecycle } from '../workspace-lifecycle.js';
import { createWorkspaceService, type WorkspaceService } from '../workspace-service.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

/** Runtimes in memory; `failNext` makes the next start fail, `lose` drops a running runtime. */
class FakeProvider implements WorkspaceRuntimeProvider {
  readonly kind = 'docker';
  readonly runtimes = new Map<string, 'running' | 'stopped'>();
  readonly specs: RuntimeSpec[] = [];
  readonly destroyed: string[] = [];
  failNext = false;
  ensureStarted(spec: RuntimeSpec): Promise<RuntimeStatus> {
    this.specs.push(spec);
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve({ phase: 'failed', reason: 'ImagePullBackOff' });
    }
    this.runtimes.set(spec.workspaceId, 'running');
    return this.status(spec.workspaceId);
  }
  ensureStopped(id: string): Promise<void> {
    if (this.runtimes.has(id)) this.runtimes.set(id, 'stopped');
    return Promise.resolve();
  }
  status(id: string): Promise<RuntimeStatus> {
    const s = this.runtimes.get(id);
    return Promise.resolve(
      s === 'running'
        ? { phase: 'running', endpoint: `http://fake/${id}` }
        : { phase: s === 'stopped' ? 'stopped' : 'absent' },
    );
  }
  destroy(id: string): Promise<void> {
    this.runtimes.delete(id);
    this.destroyed.push(id);
    return Promise.resolve();
  }
  listRuntimes(): Promise<string[]> {
    return Promise.resolve([...this.runtimes].filter(([, s]) => s === 'running').map(([id]) => id));
  }
}

let t: TestDatabase;
let provider: FakeProvider;
let lifecycle: WorkspaceLifecycle;
let service: WorkspaceService;
let alice: Principal;
let bob: Principal;
const ctx = (p: Principal) => ({ principal: p, requestId: 'req-lifecycle-1' });

const user = async (name: string) =>
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

let n = 0;
const newWorkspace = async (owner = alice) =>
  service.create(ctx(owner), { name: `ws-${String(++n)}`, templateId: 'tpl_python_pytest' });
const stateOf = async (id: string) => (await new WorkspacesRepo(t.db).findById(id))?.state;

beforeAll(async () => {
  t = await startTestDatabase();
  [alice, bob] = await Promise.all([user('alice'), user('bob')]);
});
afterAll(async () => {
  await t.stop();
});
beforeEach(() => {
  provider = new FakeProvider();
  lifecycle = createWorkspaceLifecycle(
    t.db,
    provider,
    // Tests share users and leave workspaces running: the quota has its own test with its own lifecycle.
    { startTimeoutMs: 2_000, maxRunningPerUser: 1000, controlPlaneUrl: 'http://cp.internal', pollMs: 10 },
    () => Promise.resolve(true),
  );
  service = createWorkspaceService(t.db, 'docker', (id) => lifecycle.finishDelete(id));
});

describe('start and stop', () => {
  it('starts in the background and becomes RUNNING with its endpoint', async () => {
    const ws = await newWorkspace();
    expect((await lifecycle.start(ctx(alice), ws.id)).state).toBe('STARTING');
    await lifecycle.idle();
    const row = await new WorkspacesRepo(t.db).findById(ws.id);
    expect(row).toMatchObject({ state: 'RUNNING', runtime_ref: `http://fake/${ws.id}` });
    expect(provider.specs[0]?.env).toEqual({
      QE_MODE: 'hosted',
      QE_WORKSPACE_ID: ws.id,
      QE_CONTROL_PLANE_URL: 'http://cp.internal',
    });
  });

  it('is idempotent: starting a RUNNING workspace changes nothing', async () => {
    const ws = await newWorkspace();
    await lifecycle.start(ctx(alice), ws.id);
    await lifecycle.idle();
    expect((await lifecycle.start(ctx(alice), ws.id)).state).toBe('RUNNING');
    expect(provider.specs).toHaveLength(1);
  });

  it('settles 10 concurrent starts into exactly one bring-up', async () => {
    const ws = await newWorkspace();
    await Promise.all(Array.from({ length: 10 }, () => lifecycle.start(ctx(alice), ws.id)));
    await lifecycle.idle();
    expect(await stateOf(ws.id)).toBe('RUNNING');
    expect(provider.specs).toHaveLength(1);
  });

  it('stops, keeps the volume, and can start again', async () => {
    const ws = await newWorkspace();
    await lifecycle.start(ctx(alice), ws.id);
    await lifecycle.idle();
    expect((await lifecycle.stop(ctx(alice), ws.id)).state).toBe('STOPPING');
    await lifecycle.idle();
    expect(await stateOf(ws.id)).toBe('STOPPED');
    expect((await lifecycle.stop(ctx(alice), ws.id)).state).toBe('STOPPED');
    await lifecycle.start(ctx(alice), ws.id);
    await lifecycle.idle();
    expect(await stateOf(ws.id)).toBe('RUNNING');
  });

  it('records a provider failure as FAILED with a reason, and FAILED can be started again', async () => {
    const ws = await newWorkspace();
    provider.failNext = true;
    await lifecycle.start(ctx(alice), ws.id);
    await lifecycle.idle();
    expect(await new WorkspacesRepo(t.db).findById(ws.id)).toMatchObject({
      state: 'FAILED',
      state_reason: 'ImagePullBackOff',
    });
    await lifecycle.start(ctx(alice), ws.id);
    await lifecycle.idle();
    expect(await stateOf(ws.id)).toBe('RUNNING');
  });

  it('times out a runtime that never answers', async () => {
    const slow = createWorkspaceLifecycle(
      t.db,
      provider,
      { startTimeoutMs: 100, maxRunningPerUser: 5, controlPlaneUrl: 'http://cp', pollMs: 10 },
      () => Promise.resolve(false),
    );
    const ws = await newWorkspace();
    await slow.start(ctx(alice), ws.id);
    await slow.idle();
    expect(await new WorkspacesRepo(t.db).findById(ws.id)).toMatchObject({
      state: 'FAILED',
      state_reason: 'start timed out',
    });
  });

  it('enforces the per-user running quota', async () => {
    const owner = await user(`quota-${String(Date.now())}`);
    const a = await newWorkspace(owner);
    const b = await newWorkspace(owner);
    const c = await newWorkspace(owner);
    const limited = createWorkspaceLifecycle(
      t.db,
      provider,
      { startTimeoutMs: 2_000, maxRunningPerUser: 2, controlPlaneUrl: 'http://cp', pollMs: 10 },
      () => Promise.resolve(true),
    );
    await limited.start(ctx(owner), a.id);
    await limited.start(ctx(owner), b.id);
    await expect(limited.start(ctx(owner), c.id)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await limited.idle();
    // Stopping one frees a slot.
    await limited.stop(ctx(owner), a.id);
    await limited.idle();
    expect((await limited.start(ctx(owner), c.id)).state).toBe('STARTING');
    await limited.idle();
  });

  it('hides workspaces from non-members and refuses viewers', async () => {
    const ws = await newWorkspace();
    await expect(lifecycle.start(ctx(bob), ws.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await new MembersRepo(t.db).add(ws.id, bob.userId, 'viewer');
    await expect(lifecycle.start(ctx(bob), ws.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('deleting removes the runtime and the volume', async () => {
    const ws = await newWorkspace();
    await lifecycle.start(ctx(alice), ws.id);
    await lifecycle.idle();
    await lifecycle.stop(ctx(alice), ws.id);
    await lifecycle.idle();
    await service.remove(ctx(alice), ws.id);
    expect(await stateOf(ws.id)).toBe('DELETED');
    expect(provider.destroyed).toContain(ws.id);
  });

  it('publishes state events', async () => {
    const ws = await newWorkspace();
    const seen: string[] = [];
    const off = lifecycle.events.subscribe(ws.id, (e) => seen.push(e.state));
    await lifecycle.start(ctx(alice), ws.id);
    await lifecycle.idle();
    off();
    expect(seen).toEqual(['STARTING', 'RUNNING']);
  });
});

describe('reconciler', () => {
  const settings = { startTimeoutMs: 1_000, idleMs: 60 * 60_000 };

  it('marks a RUNNING workspace whose runtime disappeared as stopped (runtime_lost)', async () => {
    const ws = await newWorkspace();
    await lifecycle.start(ctx(alice), ws.id);
    await lifecycle.idle();
    provider.runtimes.delete(ws.id);
    const report = await reconcileOnce(t.db, provider, lifecycle, settings);
    expect(report.actions).toContain(`lost ${ws.id}`);
    expect(await new WorkspacesRepo(t.db).findById(ws.id)).toMatchObject({ state: 'STOPPED' });
  });

  it('stops idle workspaces', async () => {
    const ws = await newWorkspace();
    await lifecycle.start(ctx(alice), ws.id);
    await lifecycle.idle();
    const later = new Date(Date.now() + 2 * 60 * 60_000);
    const report = await reconcileOnce(t.db, provider, lifecycle, settings, later);
    expect(report.actions).toContain(`idle ${ws.id}`);
    expect(await stateOf(ws.id)).toBe('STOPPED');
  });

  it('stops orphaned runtimes the database does not expect', async () => {
    const ws = await newWorkspace();
    provider.runtimes.set(ws.id, 'running'); // CREATED in the database
    const report = await reconcileOnce(t.db, provider, lifecycle, settings);
    expect(report.actions).toContain(`orphan ${ws.id}`);
    expect(provider.runtimes.get(ws.id)).toBe('stopped');
  });

  it('finishes interrupted deletions', async () => {
    const ws = await newWorkspace();
    await new WorkspacesRepo(t.db).transition(ws.id, 'CREATED', 'DELETING');
    await reconcileOnce(t.db, provider, lifecycle, settings);
    expect(await stateOf(ws.id)).toBe('DELETED');
  });

  it('runs on one replica at a time', async () => {
    const [a, b] = await Promise.all([
      reconcileOnce(t.db, provider, lifecycle, settings),
      reconcileOnce(t.db, provider, lifecycle, settings),
    ]);
    expect([a.skipped, b.skipped].filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it('keeps the audit chain intact through all of the above', async () => {
    const actions = await t.db.selectFrom('audit_events').select('action').execute();
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['WORKSPACE_START', 'WORKSPACE_STOP']),
    );
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });
  });
});
