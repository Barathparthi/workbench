import { Writable } from 'node:stream';

import { makePrincipal } from '../auth.js';
import type { Config } from '../config.js';
import type { HealthDeps } from '../routes/health.js';
import type { WorkspaceService } from '../workspace-service.js';

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 8080,
  DATABASE_URL: 'postgres://app@localhost/qews',
  PUBLIC_ORIGIN: 'https://qe.example',
  ALLOWED_ORIGINS: ['https://qe.example'],
  AUTH_MODE: 'dev',
  LOG_LEVEL: 'info',
  SHUTDOWN_GRACE_MS: 1000,
  RUNTIME_KIND: 'docker',
  BUILD_VERSION: '1.2.3',
  BUILD_COMMIT: 'abc123',
  BUILD_TIME: '2026-10-18T00:00:00Z',
  DEV_ROLES: ['qe.user'],
  OIDC_SCOPES: 'openid profile email',
  OIDC_GROUPS_CLAIM: 'groups',
  ROLE_MAPPINGS: {},
  SESSION_IDLE_MINUTES: 30,
  SESSION_ABSOLUTE_HOURS: 8,
  COOKIE_SECURE: true,
  ...overrides,
});

const notStubbed = (): never => {
  throw new Error('not stubbed');
};

export const fakeWorkspaces = (overrides: Partial<WorkspaceService> = {}): WorkspaceService => ({
  list: notStubbed,
  get: notStubbed,
  create: notStubbed,
  update: notStubbed,
  remove: notStubbed,
  templates: notStubbed,
  ...overrides,
});

export const fakeHealth = (checkReady: () => Promise<void> = () => Promise.resolve()): HealthDeps => ({
  state: { shuttingDown: false },
  checkReady,
  build: { version: '1.2.3', commit: 'abc123', builtAt: '2026-10-18T00:00:00Z' },
});

export const devPrincipal = makePrincipal({
  userId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70',
  username: 'dev',
  roles: ['qe.user'],
});

/** Collects log lines written by the server. */
export function logSink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}
