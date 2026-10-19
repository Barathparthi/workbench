import { EventEmitter } from 'node:events';

import type { Workspace, WorkspaceStateEvent } from '@qe/contracts';
import { DomainError, type WorkspaceState } from '@qe/domain';
import { hasWorkspaceRole } from '@qe/rbac';
import type { RuntimeProfile, RuntimeSpec, WorkspaceRuntimeProvider } from '@qe/runtime-providers';
import type { Kysely } from 'kysely';

import { writeAuditEvent } from './audit/audit-writer.js';
import type { Database } from './db/schema.js';
import { TemplatesRepo } from './repos/templates.js';
import { WorkspacesRepo, type WorkspaceRow } from './repos/workspaces.js';
import { toWorkspaceDto, type RequestContext } from './workspace-service.js';

export interface LifecycleSettings {
  readonly startTimeoutMs: number;
  readonly maxRunningPerUser: number;
  /** QE_CONTROL_PLANE_URL inside the runtime. */
  readonly controlPlaneUrl: string;
  /** How long the lifecycle waits between readiness checks. */
  readonly pollMs?: number;
}

export type StopReason = 'user' | 'idle' | 'runtime_lost' | 'start_failed' | 'stuck_stopping';

/** Answers whether the IDE behind `endpoint` serves requests (HTTP 200 on /). */
export type ReadinessProbe = (endpoint: string) => Promise<boolean>;

export const httpProbe: ReadinessProbe = async (endpoint) => {
  try {
    const res = await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(3_000), redirect: 'manual' });
    return res.status < 500;
  } catch {
    return false;
  }
};

/** Workspace state changes, for SSE subscribers on this replica. */
export class WorkspaceEvents {
  private readonly emitter = new EventEmitter().setMaxListeners(0);
  emit(event: WorkspaceStateEvent): void {
    this.emitter.emit(event.id, event);
    this.emitter.emit('*', event);
  }
  /** Every workspace's changes (the router closes sockets of workspaces that stop). */
  onAny(listener: (event: WorkspaceStateEvent) => void): () => void {
    this.emitter.on('*', listener);
    return () => this.emitter.off('*', listener);
  }
  subscribe(id: string, listener: (event: WorkspaceStateEvent) => void): () => void {
    this.emitter.on(id, listener);
    return () => this.emitter.off(id, listener);
  }
}

export interface WorkspaceLifecycle {
  start(ctx: RequestContext, id: string): Promise<Workspace>;
  stop(ctx: RequestContext, id: string): Promise<Workspace>;
  /** System stop (idle, lost runtime) — used by the reconciler. */
  stopBySystem(id: string, reason: StopReason): Promise<void>;
  /** Removes the runtime and volume of a DELETING workspace and marks it DELETED. */
  finishDelete(id: string): Promise<void>;
  readonly events: WorkspaceEvents;
  /** Ids whose bring-up is running in this process (the reconciler leaves them alone). */
  inFlight(): ReadonlySet<string>;
  /** Waits for background work (tests, graceful shutdown). */
  idle(): Promise<void>;
}

const STARTABLE: readonly WorkspaceState[] = ['CREATED', 'STOPPED', 'FAILED'];
const STOPPABLE: readonly WorkspaceState[] = ['STARTING', 'RUNNING', 'FAILED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A failure reason safe to store and show: no stack, bounded length. */
const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : 'runtime error').replace(/\s+/g, ' ').slice(0, 200);

export function createWorkspaceLifecycle(
  db: Kysely<Database>,
  provider: WorkspaceRuntimeProvider,
  settings: LifecycleSettings,
  probe: ReadinessProbe = httpProbe,
  log: { warn: (obj: object, msg: string) => void } = { warn: () => undefined },
): WorkspaceLifecycle {
  const events = new WorkspaceEvents();
  const running = new Map<string, Promise<void>>();
  const repo = () => new WorkspacesRepo(db);
  const publish = (row: WorkspaceRow | null) => {
    if (row !== null) events.emit({ id: row.id, state: row.state, reason: row.state_reason });
  };
  const background = (id: string, work: () => Promise<void>) => {
    if (running.has(id)) return;
    const p = work()
      .catch((error: unknown) => {
        log.warn({ workspaceId: id, err: error }, 'workspace background work failed');
      })
      .finally(() => running.delete(id));
    running.set(id, p);
  };

  const visibleAs = async (ctx: RequestContext, id: string) => {
    const row = await repo().findVisible(id, ctx.principal.userId);
    if (row === undefined) throw new DomainError('NOT_FOUND');
    if (!hasWorkspaceRole(row.member_role, 'editor')) throw new DomainError('FORBIDDEN');
    return row;
  };

  const specFor = async (row: WorkspaceRow): Promise<RuntimeSpec> => {
    const template = await new TemplatesRepo(db).findEnabled(row.template_id);
    if (template === undefined) throw new Error('template disabled or missing');
    return {
      workspaceId: row.id,
      image: template.image_ref,
      profile: row.resource_profile as RuntimeProfile,
      env: {
        QE_MODE: 'hosted',
        QE_WORKSPACE_ID: row.id,
        QE_CONTROL_PLANE_URL: settings.controlPlaneUrl,
      },
      git: row.git_url === null ? undefined : { url: row.git_url, ref: row.git_ref ?? 'main' },
    };
  };

  const fail = async (id: string, from: WorkspaceState, reason: string) => {
    publish(await repo().transition(id, from, 'FAILED', reason));
  };

  /** STARTING → provider up → endpoint answers → RUNNING (or FAILED with a reason). */
  const bringUp = async (id: string) => {
    const row = await repo().findById(id);
    if (row?.state !== 'STARTING') return;
    const deadline = Date.now() + settings.startTimeoutMs;
    try {
      let status = await provider.ensureStarted(await specFor(row));
      for (;;) {
        if (status.phase === 'failed') throw new Error(status.reason);
        if (status.phase === 'running' && (await probe(status.endpoint))) {
          await repo().setRuntimeRef(id, status.endpoint, new Date());
          publish(await repo().transition(id, 'STARTING', 'RUNNING'));
          return;
        }
        if (Date.now() > deadline) throw new Error('start timed out');
        await sleep(settings.pollMs ?? 1_000);
        // Someone stopped it meanwhile: leave the rest to stop().
        if ((await repo().findById(id))?.state !== 'STARTING') return;
        status = await provider.status(id);
      }
    } catch (error) {
      await fail(id, 'STARTING', reasonOf(error));
      await provider.ensureStopped(id).catch(() => undefined);
    }
  };

  const tearDown = async (id: string) => {
    await provider.ensureStopped(id);
    await repo().setRuntimeRef(id, null, new Date());
    publish(await repo().transition(id, 'STOPPING', 'STOPPED'));
  };

  const auditedTransition = async (
    row: WorkspaceRow,
    to: 'STARTING' | 'STOPPING',
    actor: { userId: string | null; requestId?: string },
    reason: StopReason,
  ) =>
    db.transaction().execute(async (tx) => {
      const moved = await new WorkspacesRepo(tx).transition(
        row.id,
        row.state,
        to,
        to === 'STOPPING' && reason !== 'user' ? reason : undefined,
      );
      if (moved === null) return null;
      await writeAuditEvent(tx, {
        action: to === 'STARTING' ? 'WORKSPACE_START' : 'WORKSPACE_STOP',
        actorType: actor.userId === null ? 'system' : 'user',
        actorUserId: actor.userId,
        resourceType: 'workspace',
        resourceId: row.id,
        result: 'success',
        ...(actor.requestId !== undefined && { requestId: actor.requestId }),
        metadata:
          to === 'STARTING' ? { name: row.name, profile: row.resource_profile } : { name: row.name, reason },
      });
      return moved;
    });

  return {
    events,

    async start(ctx, id) {
      const row = await visibleAs(ctx, id);
      if (row.state === 'RUNNING' || row.state === 'STARTING') return toWorkspaceDto(row); // idempotent
      if (!STARTABLE.includes(row.state)) {
        throw new DomainError('CONFLICT', `a ${row.state} workspace cannot be started now`);
      }
      if ((await repo().countActiveForOwner(row.owner_id)) >= settings.maxRunningPerUser) {
        throw new DomainError('QUOTA_EXCEEDED', 'too many running workspaces; stop one first', {
          details: { limit: settings.maxRunningPerUser },
        });
      }
      const moved = await auditedTransition(
        row,
        'STARTING',
        { userId: ctx.principal.userId, requestId: ctx.requestId },
        'user',
      );
      if (moved === null) return toWorkspaceDto((await repo().findById(id)) ?? row); // lost a race: report what won
      publish(moved);
      background(id, () => bringUp(id));
      return toWorkspaceDto(moved);
    },

    async stop(ctx, id) {
      const row = await visibleAs(ctx, id);
      if (row.state === 'STOPPED' || row.state === 'STOPPING' || row.state === 'CREATED')
        return toWorkspaceDto(row);
      if (!STOPPABLE.includes(row.state)) {
        throw new DomainError('CONFLICT', `a ${row.state} workspace cannot be stopped`);
      }
      const moved = await auditedTransition(
        row,
        'STOPPING',
        { userId: ctx.principal.userId, requestId: ctx.requestId },
        'user',
      );
      if (moved === null) return toWorkspaceDto((await repo().findById(id)) ?? row);
      publish(moved);
      // A bring-up in progress notices STOPPING and returns; then tear down.
      const pending = running.get(id);
      running.delete(id);
      background(id, async () => {
        await pending;
        await tearDown(id);
      });
      return toWorkspaceDto(moved);
    },

    async stopBySystem(id, reason) {
      const row = await repo().findById(id);
      if (row === undefined || !STOPPABLE.includes(row.state)) return;
      const moved = await auditedTransition(row, 'STOPPING', { userId: null }, reason);
      if (moved === null) return;
      publish(moved);
      await tearDown(id);
    },

    async finishDelete(id) {
      await provider.destroy(id);
      publish(await repo().transition(id, 'DELETING', 'DELETED'));
    },

    inFlight: () => new Set(running.keys()),
    idle: async () => {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
  };
}
