import type { WorkspaceRuntimeProvider } from '@qe/runtime-providers';
import { sql, type Kysely } from 'kysely';

import type { Database } from './db/schema.js';
import { WorkspacesRepo } from './repos/workspaces.js';
import type { WorkspaceLifecycle } from './workspace-lifecycle.js';

/** Only one replica reconciles at a time (pg_try_advisory_xact_lock key). */
const RECONCILE_LOCK = 4_242_005;

export interface ReconcileSettings {
  readonly startTimeoutMs: number;
  readonly idleMs: number;
  /** STOPPING longer than this is retried. */
  readonly stuckStoppingMs?: number;
}

export interface ReconcileReport {
  readonly skipped: boolean;
  readonly actions: string[];
}

/**
 * One reconciliation pass (Phase 05 §5.5–5.6): compares the database with the runtimes that actually exist
 * and repairs drift, then stops idle workspaces. Every action is idempotent, so a crash mid-pass is safe.
 */
export async function reconcileOnce(
  db: Kysely<Database>,
  provider: WorkspaceRuntimeProvider,
  lifecycle: WorkspaceLifecycle,
  settings: ReconcileSettings,
  now: Date = new Date(),
): Promise<ReconcileReport> {
  return db.transaction().execute(async (tx) => {
    const lock = await sql<{
      ok: boolean;
    }>`select pg_try_advisory_xact_lock(${RECONCILE_LOCK}) as ok`.execute(tx);
    if (lock.rows[0]?.ok !== true) return { skipped: true, actions: [] };

    const actions: string[] = [];
    const busy = lifecycle.inFlight();
    const rows = await new WorkspacesRepo(db).listForReconcile();
    const known = new Map(rows.map((r) => [r.id, r]));
    const age = (d: Date | string) => now.getTime() - new Date(d).getTime();

    for (const row of rows) {
      if (busy.has(row.id)) continue;
      try {
        if (row.state === 'RUNNING') {
          const status = await provider.status(row.id);
          if (status.phase !== 'running') {
            actions.push(`lost ${row.id}`);
            await lifecycle.stopBySystem(row.id, 'runtime_lost');
          } else if (row.last_active_at !== null && age(row.last_active_at) > settings.idleMs) {
            actions.push(`idle ${row.id}`);
            await lifecycle.stopBySystem(row.id, 'idle');
          }
        } else if (row.state === 'STARTING' && age(row.updated_at) > settings.startTimeoutMs + 30_000) {
          // Its bring-up died with a previous process.
          actions.push(`stuck-starting ${row.id}`);
          await lifecycle.stopBySystem(row.id, 'start_failed');
        } else if (row.state === 'STOPPING' && age(row.updated_at) > (settings.stuckStoppingMs ?? 120_000)) {
          actions.push(`stuck-stopping ${row.id}`);
          await provider.ensureStopped(row.id);
          await new WorkspacesRepo(db).transition(row.id, 'STOPPING', 'STOPPED', 'stuck_stopping');
        } else if (row.state === 'DELETING') {
          actions.push(`delete ${row.id}`);
          await lifecycle.finishDelete(row.id);
        }
      } catch (error) {
        actions.push(`error ${row.id}: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }

    // Runtimes the database does not expect to be running: stop them (volumes stay unless deleted).
    for (const id of await provider.listRuntimes()) {
      const row = known.get(id);
      if (
        busy.has(id) ||
        row?.state === 'RUNNING' ||
        row?.state === 'STARTING' ||
        row?.state === 'STOPPING'
      ) {
        continue;
      }
      actions.push(`orphan ${id}`);
      await provider.ensureStopped(id).catch(() => undefined);
    }
    return { skipped: false, actions };
  });
}

/** Runs reconcileOnce every `intervalMs`; returns a stop function. Errors are logged, never thrown. */
export function startReconciler(
  run: () => Promise<ReconcileReport>,
  intervalMs: number,
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void },
): () => Promise<void> {
  let current: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    current = run()
      .then((r) => {
        if (r.actions.length > 0) log.info({ actions: r.actions }, 'reconciled workspaces');
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'reconcile pass failed');
      });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await current;
  };
}
