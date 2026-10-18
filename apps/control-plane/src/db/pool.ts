import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import type { Database } from './schema.js';

/** Server-side limits on every connection: no runaway statements or idle transactions (03 §3.5). */
const SESSION_OPTIONS = '-c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000';

/**
 * `onIdleError` sees errors on idle connections (e.g. the server restarted or terminated the backend). The
 * pool drops such a connection by itself; without a listener Node treats the event as fatal and exits.
 */
export function createPool(
  connectionString: string,
  max = 10,
  onIdleError: (error: Error) => void = () => undefined,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options: SESSION_OPTIONS,
  });
  pool.on('error', onIdleError);
  return pool;
}

export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Resolves when `SELECT 1` answers within `timeoutMs`, rejects otherwise. */
export async function pingDatabase(db: Kysely<Database>, timeoutMs = 1_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`database did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([sql`select 1`.execute(db), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
