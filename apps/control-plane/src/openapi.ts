import type { SessionAuth } from './auth/session-auth.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import type { WorkspaceService } from './workspace-service.js';

const unused = (): never => {
  throw new Error('not used while generating OpenAPI');
};

/** The OpenAPI document generated from the route schemas (03 §3.8); no database needed. */
export async function generateOpenApi(): Promise<Record<string, unknown>> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused@localhost/unused',
    PUBLIC_ORIGIN: 'https://qe-workspace.example',
    ALLOWED_ORIGINS: 'https://qe-workspace.example',
    AUTH_MODE: 'oidc',
    LOG_LEVEL: 'fatal',
    SHUTDOWN_GRACE_MS: '0',
    BUILD_VERSION: '1',
    BUILD_COMMIT: 'openapi',
    BUILD_TIME: 'openapi',
    OIDC_ISSUER: 'https://idp.example/realms/qe',
    OIDC_CLIENT_ID: 'openapi',
    OIDC_CLIENT_SECRET: 'openapi',
    OIDC_REDIRECT_URL: 'https://qe-workspace.example/auth/callback',
    SESSION_SECRET: 'openapi-generation-only-not-a-secret',
  });
  const workspaces: WorkspaceService = {
    list: unused,
    get: unused,
    create: unused,
    update: unused,
    remove: unused,
    templates: unused,
  };
  // Registers the login routes too; nothing is called while generating.
  const auth: SessionAuth = {
    authenticate: unused,
    startLogin: unused,
    finishLogin: unused,
    logout: unused,
  };
  const app = await buildServer(config, {
    workspaces,
    sessions: {
      auth,
      redirectUrl: 'https://qe-workspace.example/auth/callback',
      publicOrigin: 'https://qe-workspace.example',
      cookieSecure: true,
      cookieSecret: 'openapi-generation-only-not-a-secret',
    },
    health: {
      state: { shuttingDown: false },
      checkReady: unused,
      build: { version: '1', commit: 'x', builtAt: 'x' },
    },
  });
  await app.ready();
  const document = app.swagger() as unknown as Record<string, unknown>;
  await app.close();
  return document;
}
