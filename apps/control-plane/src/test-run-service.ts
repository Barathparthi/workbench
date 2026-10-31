import type {
  BrokerTestRunResult,
  CreateTestRunRequest,
  RemoteTestRunResponse,
  StartRemoteTestRunRequest,
  TestRun,
  TestRunResultRequest,
} from '@qe/contracts';
import { TestFailureRecord, TestFrameworkName, TestSelectorRecord } from '@qe/contracts';
import { DomainError } from '@qe/domain';
import { hasWorkspaceRole } from '@qe/rbac';
import type { Kysely, Selectable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { writeAuditEvent } from './audit/audit-writer.js';
import type { Database, TestArtifactsTable, TestRunsTable } from './db/schema.js';
import type { RemoteSessionService } from './remote-session-service.js';
import { WorkspacesRepo } from './repos/workspaces.js';
import type { RequestContext } from './workspace-service.js';

/** The QE runner's records (05_API_CONTRACTS §2.5, PHASE_11 §11.4–11.5). */
export interface TestRunService {
  create(ctx: RequestContext, workspaceId: string, input: CreateTestRunRequest): Promise<TestRun>;
  finish(ctx: RequestContext, runId: string, input: TestRunResultRequest): Promise<TestRun>;
  list(ctx: RequestContext, workspaceId: string | undefined, limit: number): Promise<TestRun[]>;
  get(ctx: RequestContext, runId: string): Promise<TestRun>;
  /** A run on a remote target, carried by an exec session the broker opens (P11.4). */
  startRemote(
    ctx: RequestContext,
    targetId: string,
    input: StartRemoteTestRunRequest,
    origin: string | undefined,
  ): Promise<RemoteTestRunResponse>;
  /** The broker's result of a remote run (internal). */
  finishFromBroker(runId: string, input: BrokerTestRunResult): Promise<TestRun>;
  cancel(ctx: RequestContext, runId: string): Promise<TestRun>;
}

type RunRow = Selectable<TestRunsTable>;
type ArtifactRow = Selectable<TestArtifactsTable>;

const Counts = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  errors: z.number(),
  skipped: z.number(),
});

/** Stored JSON read back through the same schemas it was written with; anything else reads as empty. */
function readJson<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
  return parsed.success ? parsed.data : undefined;
}

export function toTestRunDto(row: RunRow, artifacts: readonly ArtifactRow[]): TestRun {
  const counts = readJson(Counts, row.counts_json);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    userId: row.user_id,
    framework: TestFrameworkName.parse(row.framework),
    selector: readJson(TestSelectorRecord, row.selector) ?? { kind: 'all' },
    state: row.state,
    exitCode: row.exit_code,
    counts: counts === undefined || row.finished_at === null ? null : counts,
    failures: readJson(z.array(TestFailureRecord), row.failures_json) ?? [],
    truncated: row.truncated,
    artifacts: artifacts.map((a) => ({
      id: a.id,
      kind: a.kind,
      path: a.storage_ref,
      sizeBytes: Number(a.size_bytes),
      sha256: a.sha256,
    })),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const NO_COUNTS = { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 };

/** A result's own consistency: the counts add up, and every artifact is a file of this run's folder. */
function checkResult(runId: string, input: TestRunResultRequest): void {
  const { counts } = input;
  if (counts.total !== counts.passed + counts.failed + counts.errors + counts.skipped) {
    throw new DomainError('INVALID_REQUEST', 'counts do not add up', { details: { field: 'counts' } });
  }
  const folder = `.qe-runs/${runId}/`;
  if (input.artifacts.some((a) => !a.path.startsWith(folder))) {
    throw new DomainError('INVALID_REQUEST', 'artifacts must be files of this run', {
      details: { field: 'artifacts' },
    });
  }
}

export function createTestRunService(
  db: Kysely<Database>,
  /** Remote runs need the session service (Phase 07–08); without it they are refused. */
  sessions?: RemoteSessionService,
): TestRunService {
  /** The workspace, if the user is a member: everyone else gets 404, administrators included (07 §5). */
  const workspace = async (id: string, userId: string) => {
    const row = await new WorkspacesRepo(db).findVisible(id, userId);
    if (row === undefined) throw new DomainError('NOT_FOUND');
    return row;
  };

  /** Runs need write access to the project folder (.qe-runs): editors and owners only. */
  const editableWorkspace = async (id: string, userId: string) => {
    const ws = await workspace(id, userId);
    if (!hasWorkspaceRole(ws.member_role, 'editor')) throw new DomainError('FORBIDDEN');
    return ws;
  };

  /**
   * A run the user may see: one of a workspace they are a member of, or — for a remote run that belongs to no
   * workspace — their own. Everyone else gets 404.
   */
  const visibleRun = async (runId: string, userId: string): Promise<RunRow> => {
    const row = await db
      .selectFrom('test_runs')
      .leftJoin('workspace_members', (join) =>
        join
          .onRef('workspace_members.workspace_id', '=', 'test_runs.workspace_id')
          .on('workspace_members.user_id', '=', userId),
      )
      .leftJoin('workspaces', 'workspaces.id', 'test_runs.workspace_id')
      .selectAll('test_runs')
      .where('test_runs.id', '=', runId)
      .where((eb) =>
        eb.or([
          eb.and([eb('workspace_members.user_id', 'is not', null), eb('workspaces.state', '<>', 'DELETED')]),
          eb.and([eb('test_runs.workspace_id', 'is', null), eb('test_runs.user_id', '=', userId)]),
        ]),
      )
      .executeTakeFirst();
    if (row === undefined) throw new DomainError('NOT_FOUND');
    return row;
  };

  const artifactsOf = (runIds: readonly string[]) =>
    runIds.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom('test_artifacts')
          .selectAll()
          .where('test_run_id', 'in', runIds)
          .orderBy('created_at')
          .execute();

  const dto = async (row: RunRow) => toTestRunDto(row, await artifactsOf([row.id]));

  /** Records how a run ended, once: the update only applies while it is RUNNING. */
  const record = (
    run: RunRow,
    input: TestRunResultRequest,
    actor: { type: 'user' | 'service'; requestId?: string },
  ) =>
    db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('test_runs')
        .set({
          state: input.state,
          exit_code: input.exitCode ?? null,
          duration_ms: input.durationMs,
          counts_json: JSON.stringify(input.counts),
          failures_json: JSON.stringify(input.failures),
          truncated: input.truncated,
          finished_at: new Date(),
        })
        .where('id', '=', run.id)
        .where('state', '=', 'RUNNING')
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) throw new DomainError('CONFLICT', 'the run was finished meanwhile');
      for (const artifact of input.artifacts) {
        await tx
          .insertInto('test_artifacts')
          .values({
            id: uuidv7(),
            test_run_id: run.id,
            kind: artifact.kind,
            storage_ref: artifact.path,
            size_bytes: artifact.sizeBytes,
            sha256: artifact.sha256,
          })
          .execute();
      }
      const base = {
        actorType: actor.type,
        // The broker reports on the user's behalf, as for sessions (Phase 08).
        actorUserId: run.user_id,
        resourceType: 'test_run',
        resourceId: run.id,
        ...(actor.requestId !== undefined && { requestId: actor.requestId }),
      };
      if (input.state === 'CANCELLED') {
        await writeAuditEvent(tx, {
          ...base,
          action: 'QE_TEST_CANCELLED',
          result: 'success',
          metadata: { durationMs: input.durationMs },
        });
      } else {
        await writeAuditEvent(tx, {
          ...base,
          action: 'QE_TEST_FINISHED',
          // An error is the run's own failure (could not start, crashed), not a refused request.
          result: input.state === 'ERROR' ? 'failure' : 'success',
          metadata: {
            state: input.state,
            ...(input.exitCode !== undefined && { exitCode: input.exitCode }),
            durationMs: input.durationMs,
            ...input.counts,
          },
        });
      }
      return toTestRunDto(
        row,
        await tx.selectFrom('test_artifacts').selectAll().where('test_run_id', '=', run.id).execute(),
      );
    });

  return {
    async create(ctx, workspaceId, input) {
      await editableWorkspace(workspaceId, ctx.principal.userId);
      return db.transaction().execute(async (tx) => {
        const row = await tx
          .insertInto('test_runs')
          .values({
            id: uuidv7(),
            workspace_id: workspaceId,
            target_id: null,
            user_id: ctx.principal.userId,
            framework: input.framework,
            selector: JSON.stringify(input.selector),
            state: 'RUNNING',
            exit_code: null,
            counts_json: '{}',
            started_at: new Date(),
            finished_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAuditEvent(tx, {
          action: 'QE_TEST_STARTED',
          actorType: 'user',
          actorUserId: ctx.principal.userId,
          resourceType: 'test_run',
          resourceId: row.id,
          result: 'success',
          requestId: ctx.requestId,
          metadata: { workspaceId, framework: input.framework, selectorKind: input.selector.kind },
        });
        return toTestRunDto(row, []);
      });
    },

    async finish(ctx, runId, input) {
      const run = await visibleRun(runId, ctx.principal.userId);
      if (run.user_id !== ctx.principal.userId) {
        throw new DomainError('FORBIDDEN', 'only the user who started a run records its result');
      }
      // A remote run's result is what the broker read on the target, not what a client says.
      if (run.session_id !== null)
        throw new DomainError('FORBIDDEN', 'remote runs are recorded by the broker');
      if (run.state !== 'RUNNING') throw new DomainError('CONFLICT', `the run is already ${run.state}`);
      checkResult(runId, input);
      return record(run, input, { type: 'user', requestId: ctx.requestId });
    },

    async list(ctx, workspaceId, limit) {
      let query = db.selectFrom('test_runs').selectAll();
      if (workspaceId === undefined) {
        query = query.where('workspace_id', 'is', null).where('user_id', '=', ctx.principal.userId);
      } else {
        await workspace(workspaceId, ctx.principal.userId);
        query = query.where('workspace_id', '=', workspaceId);
      }
      const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
      const artifacts = await artifactsOf(rows.map((r) => r.id));
      return rows.map((r) =>
        toTestRunDto(
          r,
          artifacts.filter((a) => a.test_run_id === r.id),
        ),
      );
    },

    async get(ctx, runId) {
      return dto(await visibleRun(runId, ctx.principal.userId));
    },

    async startRemote(ctx, targetId, input, origin) {
      if (sessions === undefined)
        throw new DomainError('TARGET_NOT_ALLOWED', 'remote systems are not configured');
      if (input.workspaceId !== undefined) await editableWorkspace(input.workspaceId, ctx.principal.userId);
      const runId = uuidv7();
      let created: RunRow | undefined;
      // The session's permission (remote:execute), the policy's `exec` capability and the session limit are checked
      // by the session service; the run is recorded in the same transaction as the session it rides on.
      const session = await sessions.open(
        ctx,
        targetId,
        { kind: 'exec', ...(input.workspaceId !== undefined && { workspaceId: input.workspaceId }) },
        origin,
        async (tx, sessionId) => {
          created = await tx
            .insertInto('test_runs')
            .values({
              id: runId,
              workspace_id: input.workspaceId ?? null,
              target_id: targetId,
              user_id: ctx.principal.userId,
              framework: input.framework,
              selector: JSON.stringify(input.selector),
              state: 'RUNNING',
              exit_code: null,
              counts_json: '{}',
              started_at: new Date(),
              finished_at: null,
              session_id: sessionId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAuditEvent(tx, {
            action: 'QE_TEST_STARTED',
            actorType: 'user',
            actorUserId: ctx.principal.userId,
            resourceType: 'test_run',
            resourceId: runId,
            result: 'success',
            requestId: ctx.requestId,
            metadata: {
              ...(input.workspaceId !== undefined && { workspaceId: input.workspaceId }),
              targetId,
              framework: input.framework,
              selectorKind: input.selector.kind,
            },
          });
        },
      );
      if (created === undefined) throw new DomainError('INTERNAL_ERROR', 'the run was not recorded');
      return {
        run: toTestRunDto(created, []),
        session: {
          sessionId: session.sessionId,
          streamUrl: session.streamUrl,
          ticket: session.ticket,
          expiresAt: session.expiresAt,
        },
      };
    },

    async finishFromBroker(runId, input) {
      const run = await db.selectFrom('test_runs').selectAll().where('id', '=', runId).executeTakeFirst();
      // Only the session that carries the run reports its result.
      if (run?.session_id !== input.sessionId) throw new DomainError('NOT_FOUND');
      if (run.state !== 'RUNNING') throw new DomainError('CONFLICT', `the run is already ${run.state}`);
      const result: TestRunResultRequest = {
        state: input.state,
        ...(input.exitCode !== undefined && { exitCode: input.exitCode }),
        durationMs: input.durationMs,
        counts: input.counts,
        failures: input.failures,
        truncated: input.truncated,
        artifacts: input.artifacts,
      };
      checkResult(runId, result);
      return record(run, result, { type: 'service' });
    },

    async cancel(ctx, runId) {
      const run = await visibleRun(runId, ctx.principal.userId);
      if (run.user_id !== ctx.principal.userId)
        throw new DomainError('FORBIDDEN', 'only the user who started a run cancels it');
      if (run.state !== 'RUNNING') throw new DomainError('CONFLICT', `the run is already ${run.state}`);
      if (run.session_id !== null && sessions !== undefined) {
        // Closing the exec session makes the broker stop the remote run (INT, then KILL) and report it CANCELLED.
        await sessions.close(ctx, run.session_id);
        return dto(run);
      }
      // A run in the IDE is stopped there; this records one whose IDE went away without saying how it ended.
      const startedAt = run.started_at ?? run.created_at;
      return record(
        run,
        {
          state: 'CANCELLED',
          durationMs: Math.max(0, Date.now() - startedAt.getTime()),
          counts: NO_COUNTS,
          failures: [],
          truncated: false,
          artifacts: [],
        },
        { type: 'user', requestId: ctx.requestId },
      );
    },
  };
}
