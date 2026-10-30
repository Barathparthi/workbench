import type { CreateTestRunRequest, TestRun, TestRunResultRequest } from '@qe/contracts';
import { TestFailureRecord, TestFrameworkName, TestSelectorRecord } from '@qe/contracts';
import { DomainError } from '@qe/domain';
import { hasWorkspaceRole } from '@qe/rbac';
import type { Kysely, Selectable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { writeAuditEvent } from './audit/audit-writer.js';
import type { Database, TestArtifactsTable, TestRunsTable } from './db/schema.js';
import { WorkspacesRepo } from './repos/workspaces.js';
import type { RequestContext } from './workspace-service.js';

/** The QE runner's records (05_API_CONTRACTS §2.5, PHASE_11 §11.5). */
export interface TestRunService {
  create(ctx: RequestContext, workspaceId: string, input: CreateTestRunRequest): Promise<TestRun>;
  finish(ctx: RequestContext, runId: string, input: TestRunResultRequest): Promise<TestRun>;
  list(ctx: RequestContext, workspaceId: string, limit: number): Promise<TestRun[]>;
  get(ctx: RequestContext, runId: string): Promise<TestRun>;
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

export function createTestRunService(db: Kysely<Database>): TestRunService {
  /** The workspace, if the user is a member: everyone else gets 404, administrators included (07 §5). */
  const workspace = async (id: string, userId: string) => {
    const row = await new WorkspacesRepo(db).findVisible(id, userId);
    if (row === undefined) throw new DomainError('NOT_FOUND');
    return row;
  };

  /** A run, if the user is a member of its workspace. */
  const visibleRun = async (runId: string, userId: string): Promise<RunRow> => {
    const row = await db
      .selectFrom('test_runs')
      .innerJoin('workspace_members', 'workspace_members.workspace_id', 'test_runs.workspace_id')
      .innerJoin('workspaces', 'workspaces.id', 'test_runs.workspace_id')
      .selectAll('test_runs')
      .where('test_runs.id', '=', runId)
      .where('workspace_members.user_id', '=', userId)
      .where('workspaces.state', '<>', 'DELETED')
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

  return {
    async create(ctx, workspaceId, input) {
      const ws = await workspace(workspaceId, ctx.principal.userId);
      // Runs write into the project folder (.qe-runs): editors and owners only.
      if (!hasWorkspaceRole(ws.member_role, 'editor')) throw new DomainError('FORBIDDEN');
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
      if (run.state !== 'RUNNING') throw new DomainError('CONFLICT', `the run is already ${run.state}`);
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
      return db.transaction().execute(async (tx) => {
        const row = await tx
          .updateTable('test_runs')
          .set({
            state: input.state,
            exit_code: input.exitCode ?? null,
            duration_ms: input.durationMs,
            counts_json: JSON.stringify(counts),
            failures_json: JSON.stringify(input.failures),
            truncated: input.truncated,
            finished_at: new Date(),
          })
          .where('id', '=', runId)
          .where('state', '=', 'RUNNING')
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) throw new DomainError('CONFLICT', 'the run was finished meanwhile');
        for (const artifact of input.artifacts) {
          await tx
            .insertInto('test_artifacts')
            .values({
              id: uuidv7(),
              test_run_id: runId,
              kind: artifact.kind,
              storage_ref: artifact.path,
              size_bytes: artifact.sizeBytes,
              sha256: artifact.sha256,
            })
            .execute();
        }
        const base = {
          actorType: 'user' as const,
          actorUserId: ctx.principal.userId,
          resourceType: 'test_run',
          resourceId: runId,
          requestId: ctx.requestId,
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
              ...counts,
            },
          });
        }
        return toTestRunDto(
          row,
          await tx.selectFrom('test_artifacts').selectAll().where('test_run_id', '=', runId).execute(),
        );
      });
    },

    async list(ctx, workspaceId, limit) {
      await workspace(workspaceId, ctx.principal.userId);
      const rows = await db
        .selectFrom('test_runs')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
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
  };
}
