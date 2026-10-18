import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import type pg from 'pg';

import { loadMigrations, migrate } from '../db/migrator.js';
import { createDatabase, createPool } from '../db/pool.js';
import type { Database } from '../db/schema.js';

/** The same PostgreSQL 18.6 image as deploy/compose (pinned by digest). */
export const POSTGRES_IMAGE =
  'postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

/** Login role the application uses: a member of qews_app with nothing else (like production). */
const APP_USER = 'qews_app_login';
const APP_PASSWORD = 'integration-only';

export interface TestDatabase {
  readonly container: StartedPostgreSqlContainer;
  /** Superuser pool: runs migrations and test setup that the application role must not be able to do. */
  readonly adminPool: pg.Pool;
  /** Application-role pool and Kysely instance, as the control plane connects in production. */
  readonly appPool: pg.Pool;
  readonly db: Kysely<Database>;
  stop(): Promise<void>;
}

export const appUrl = (container: StartedPostgreSqlContainer): string =>
  `postgres://${APP_USER}:${APP_PASSWORD}@${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}`;

/** Starts a disposable PostgreSQL, applies the migrations and creates the application login role. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const adminPool = createPool(container.getConnectionUri(), 4);
  await migrate(adminPool, await loadMigrations());
  await adminPool.query(`CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE qews_app`);
  const appPool = createPool(appUrl(container), 25);
  const db = createDatabase(appPool);
  return {
    container,
    adminPool,
    appPool,
    db,
    async stop() {
      await db.destroy();
      await adminPool.end();
      await container.stop();
    },
  };
}
