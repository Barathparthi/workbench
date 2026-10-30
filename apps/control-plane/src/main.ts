import { ZodError } from 'zod';

import { makePrincipal } from './auth.js';
import { oidcAuthenticator } from './auth/oidc-auth.js';
import { describeConfigError, loadConfig, oidcSettings, type Config } from './config.js';
import { loadMigrations, migrationsUpToDate } from './db/migrator.js';
import { createDatabase, createPool, pingDatabase } from './db/pool.js';
import { UsersRepo } from './repos/users.js';
import { WebSessionsRepo } from './repos/web-sessions.js';
import { WorkspacesRepo } from './repos/workspaces.js';
import { reconcileOnce, startReconciler } from './reconciler.js';
import { createWorkspaceLifecycle } from './workspace-lifecycle.js';
import { lookup } from 'node:dns/promises';
import { httpBroker } from './broker-client.js';
import { createRemoteFileService } from './remote-file-service.js';
import { createRemoteSessionService } from './remote-session-service.js';
import { createTargetService } from './target-service.js';
import {
  DockerProvider,
  inClusterConnection,
  kubeApi,
  KubernetesProvider,
  socketEngine,
  type WorkspaceRuntimeProvider,
} from '@qe/runtime-providers';
import { buildServer } from './server.js';
import { createShutdown } from './shutdown.js';
import { createTestRunService } from './test-run-service.js';
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

// AUTH_MODE=oidc: browser sessions against the configured IdP (local Keycloak in development), and with
// OIDC_DESKTOP_CLIENT_ID the desktop app's bearer access tokens too (PHASE_10 §10.4).
const oidc = config.AUTH_MODE === 'oidc' ? oidcSettings(config) : undefined;
const sessions =
  oidc === undefined
    ? undefined
    : {
        auth: oidcAuthenticator(db, oidc),
        desktop:
          oidc.desktop === undefined
            ? undefined
            : { issuer: oidc.issuer, clientId: oidc.desktop.clientId, scopes: oidc.scopes },
        redirectUrl: oidc.redirectUrl,
        publicOrigin: oidc.publicOrigin,
        cookieSecure: oidc.cookieSecure,
        cookieSecret: oidc.sessionSecret,
      };

// Workspace runtimes (Phase 05): Docker for development and single hosts, Kubernetes when hosted.
// RUNTIME_KIND=local (desktop/local web) has no control-plane runtimes.
const provider: WorkspaceRuntimeProvider | undefined =
  config.RUNTIME_KIND === 'docker'
    ? new DockerProvider({
        engine: socketEngine(config.DOCKER_SOCKET),
        network: config.RUNTIME_NETWORK,
        endpointMode: config.RUNTIME_ENDPOINT_MODE,
      })
    : config.RUNTIME_KIND === 'kubernetes'
      ? new KubernetesProvider({
          api: kubeApi(inClusterConnection()),
          namespace: config.K8S_NAMESPACE,
          storageClass: config.K8S_STORAGE_CLASS,
        })
      : undefined;
let logWarn = (obj: object, msg: string) => {
  console.warn(msg, obj);
};
const lifecycle =
  provider === undefined
    ? undefined
    : createWorkspaceLifecycle(
        db,
        provider,
        {
          startTimeoutMs: config.WORKSPACE_START_TIMEOUT_SEC * 1000,
          maxRunningPerUser: config.MAX_RUNNING_WORKSPACES_PER_USER,
          controlPlaneUrl: config.CONTROL_PLANE_INTERNAL_URL ?? config.PUBLIC_ORIGIN,
        },
        undefined,
        {
          warn: (obj, msg) => {
            logWarn(obj, msg);
          },
        },
      );

// Remote targets and sessions (Phase 07). The resolver returns every address of a name (SSRF guard).
const broker = httpBroker(config.BROKER_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);
const remote = {
  targets: createTargetService(db, {
    deniedCidrs: config.TARGET_DENY_CIDRS,
    resolver: async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  }),
  sessions: createRemoteSessionService(db, {
    ticketTtlMs: config.SESSION_TICKET_TTL_SEC * 1000,
    allowedOrigins: config.ALLOWED_ORIGINS,
    brokerPublicUrl: config.BROKER_PUBLIC_URL,
    closeOnBroker: broker.close,
  }),
  // Remote files (Phase 09): every operation goes through the broker's SFTP connection for the session.
  files: createRemoteFileService(db, {
    broker: broker.files,
    ticketTtlMs: config.SESSION_TICKET_TTL_SEC * 1000,
    closeOnBroker: broker.close,
  }),
};

const app = await buildServer(config, {
  remote,
  testRuns: createTestRunService(db),
  workspaces: createWorkspaceService(
    db,
    config.RUNTIME_KIND,
    lifecycle === undefined ? undefined : (id) => lifecycle.finishDelete(id),
  ),
  runtime:
    lifecycle === undefined
      ? undefined
      : {
          lifecycle,
          lookup: (id, userId) => new WorkspacesRepo(db).routeFor(id, userId),
          touch: (id) => new WorkspacesRepo(db).touchActivity(id, new Date()),
        },
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

logWarn = (obj, msg) => {
  app.log.warn(obj, msg);
};
const stopReconciler =
  provider === undefined || lifecycle === undefined
    ? undefined
    : startReconciler(
        () =>
          reconcileOnce(db, provider, lifecycle, {
            startTimeoutMs: config.WORKSPACE_START_TIMEOUT_SEC * 1000,
            idleMs: config.WORKSPACE_IDLE_MINUTES * 60_000,
          }),
        config.RECONCILE_INTERVAL_SEC * 1000,
        app.log,
      );

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
  async () => {
    clearInterval(purge);
    await stopReconciler?.();
    await lifecycle?.idle();
    await db.destroy();
  },
  config.SHUTDOWN_GRACE_MS,
);
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
await app.listen({ host: config.HOST, port: config.PORT });
