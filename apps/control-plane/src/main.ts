import { ZodError } from 'zod';

import { makePrincipal } from './auth.js';
import { openIdProvider } from './auth/oidc.js';
import { createSessionAuth } from './auth/session-auth.js';
import { describeConfigError, loadConfig, oidcSettings, type Config } from './config.js';
import { loadMigrations, migrationsUpToDate } from './db/migrator.js';
import { createDatabase, createPool, pingDatabase } from './db/pool.js';
import { UsersRepo } from './repos/users.js';
import { WebSessionsRepo } from './repos/web-sessions.js';
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
    ? makePrincipal({
        userId: await new UsersRepo(db).upsertIdentity({
          issuer: 'dev',
          subject: 'dev',
          username: 'dev',
          displayName: 'Dev User',
        }),
        username: 'dev',
        displayName: 'Dev User',
        roles: config.DEV_ROLES,
      })
    : undefined;

// AUTH_MODE=oidc: browser sessions against the configured IdP (local Keycloak in development).
const oidc = config.AUTH_MODE === 'oidc' ? oidcSettings(config) : undefined;
const sessions =
  oidc === undefined
    ? undefined
    : {
        auth: createSessionAuth(db, openIdProvider(oidc), oidc),
        redirectUrl: oidc.redirectUrl,
        publicOrigin: oidc.publicOrigin,
        cookieSecure: oidc.cookieSecure,
        cookieSecret: oidc.sessionSecret,
      };

const app = await buildServer(config, {
  workspaces: createWorkspaceService(db, config.RUNTIME_KIND),
  devPrincipal,
  sessions,
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

// Expired and idle sessions are refused on use; this sweep only keeps the table small.
const purge =
  oidc === undefined
    ? undefined
    : setInterval(() => {
        new WebSessionsRepo(db).purgeExpired(new Date(), oidc.idleMs).catch((error: unknown) => {
          app.log.warn({ err: error }, 'session purge failed');
        });
      }, 15 * 60_000);
purge?.unref();

const shutdown = createShutdown(
  app,
  state,
  () => {
    clearInterval(purge);
    return db.destroy();
  },
  config.SHUTDOWN_GRACE_MS,
);
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
await app.listen({ host: config.HOST, port: config.PORT });
