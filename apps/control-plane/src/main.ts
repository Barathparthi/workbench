import { ZodError } from 'zod';

import { describeConfigError, loadConfig, type Config } from './config.js';
import { loadMigrations, migrationsUpToDate } from './db/migrator.js';
import { createDatabase, createPool, pingDatabase } from './db/pool.js';
import { UsersRepo } from './repos/users.js';
import { buildServer } from './server.js';
import { createShutdown } from './shutdown.js';
import { createWorkspaceService } from './workspace-service.js';

function configOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    console.error(`control plane cannot start: ${describeConfigError(error)}`);
    return process.exit(78);
  }
}

const config = configOrExit();
// pg attaches the client (with its connection password) to idle errors: log the code and message only.
let logIdleError = (error: Error & { code?: string }) => {
  console.error(`idle database connection lost: ${error.code ?? ''} ${error.message}`);
};
const pool = createPool(config.DATABASE_URL, 10, (error) => {
  logIdleError(error);
});
const db = createDatabase(pool);
const migrations = await loadMigrations();
const state = { shuttingDown: false };

// Development only (forbidden in production by config): every request acts as this seeded user.
const devPrincipal =
  config.AUTH_MODE === 'dev'
    ? {
        userId: await new UsersRepo(db).upsertIdentity({
          issuer: 'dev',
          subject: 'dev',
          username: 'dev',
          displayName: 'Dev User',
        }),
        username: 'dev',
      }
    : undefined;

const app = await buildServer(config, {
  workspaces: createWorkspaceService(db, config.RUNTIME_KIND),
  devPrincipal,
  health: {
    state,
    build: { version: config.BUILD_VERSION, commit: config.BUILD_COMMIT, builtAt: config.BUILD_TIME },
    checkReady: async () => {
      await pingDatabase(db);
      if (!(await migrationsUpToDate(pool, migrations)))
        throw new Error('migrations are not at the expected version');
    },
  },
});

logIdleError = (error) => {
  app.log.warn({ code: error.code, message: error.message }, 'idle database connection lost');
};

const shutdown = createShutdown(app, state, () => db.destroy(), config.SHUTDOWN_GRACE_MS);
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
await app.listen({ host: config.HOST, port: config.PORT });
