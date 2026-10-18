import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { WorkspaceService } from './workspace-service.js';

const unused = (): never => {
  throw new Error('not used while generating OpenAPI');
};

/** The OpenAPI document generated from the route schemas (03 §3.8); no database needed. */
export async function generateOpenApi(): Promise<Record<string, unknown>> {
  const config: Config = {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 8080,
    DATABASE_URL: 'postgres://unused@localhost/unused',
    PUBLIC_ORIGIN: 'https://qe-workspace.example',
    ALLOWED_ORIGINS: ['https://qe-workspace.example'],
    AUTH_MODE: 'oidc',
    LOG_LEVEL: 'fatal',
    SHUTDOWN_GRACE_MS: 0,
    RUNTIME_KIND: 'docker',
    BUILD_VERSION: '1',
    BUILD_COMMIT: 'openapi',
    BUILD_TIME: 'openapi',
  };
  const workspaces: WorkspaceService = {
    list: unused,
    get: unused,
    create: unused,
    update: unused,
    remove: unused,
    templates: unused,
  };
  const app = await buildServer(config, {
    workspaces,
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
