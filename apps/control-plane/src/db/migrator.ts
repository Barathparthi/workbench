import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

/** apps/control-plane/migrations, from both src/db (tests) and dist/db (runtime). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Serialises migration runs across processes (pg_advisory_lock key). */
const MIGRATION_LOCK = 4_242_001;

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(dir, file), 'utf8');
      return {
        version: file.slice(0, 4),
        name: file.slice(5, -4),
        sql: text,
        checksum: createHash('sha256').update(text).digest('hex'),
      };
    }),
  );
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

/**
 * Applies pending migrations in order, each in its own transaction, under an advisory lock. Refuses to run
 * when an applied migration's file has changed (merged migrations are never edited, 06 §5).
 */
export async function migrate(pool: pg.Pool, migrations: readonly Migration[]): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(CREATE_TABLE);
    const done = new Map(
      (
        await client.query<{ version: string; checksum: string }>(
          'SELECT version, checksum FROM schema_migrations',
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );
    for (const m of migrations) {
      const checksum = done.get(m.version);
      if (checksum !== undefined) {
        if (checksum !== m.checksum)
          throw new MigrationError(`migration ${m.version}_${m.name} was changed after it was applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.name,
          m.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationError(`migration ${m.version}_${m.name} failed: ${(error as Error).message}`);
      }
      applied.push(`${m.version}_${m.name}`);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** True when the database has exactly the bundled migrations applied, unchanged. */
export async function migrationsUpToDate(pool: pg.Pool, migrations: readonly Migration[]): Promise<boolean> {
  const result = await pool.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const applied = new Map(result.rows.map((r) => [r.version, r.checksum]));
  return applied.size === migrations.length && migrations.every((m) => applied.get(m.version) === m.checksum);
}
