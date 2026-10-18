import type { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';

import { describeConfigError, loadConfig } from '../config.js';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://qews_app_login:s3cret-canary@localhost:5432/qews',
  PUBLIC_ORIGIN: 'http://localhost:8080',
  ALLOWED_ORIGINS: 'http://localhost:3000, http://localhost:8080',
  AUTH_MODE: 'dev',
};

const issues = (input: Record<string, string>) => {
  try {
    loadConfig(input);
  } catch (error) {
    return describeConfigError(error as ZodError);
  }
  throw new Error('expected loadConfig to throw');
};

describe('loadConfig', () => {
  it('applies defaults and splits the origin list', () => {
    expect(loadConfig(env)).toMatchObject({
      PORT: 8080,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      SHUTDOWN_GRACE_MS: 30_000,
      ALLOWED_ORIGINS: ['http://localhost:3000', 'http://localhost:8080'],
    });
  });

  it('forbids AUTH_MODE=dev in production', () => {
    expect(issues({ ...env, NODE_ENV: 'production' })).toBe(
      'AUTH_MODE: AUTH_MODE=dev is forbidden in production',
    );
    expect(loadConfig({ ...env, NODE_ENV: 'production', AUTH_MODE: 'oidc' }).AUTH_MODE).toBe('oidc');
  });

  it.each([
    [{ DATABASE_URL: 'mysql://x@y/z' }, 'DATABASE_URL: must be a postgres:// URL'],
    [{ PUBLIC_ORIGIN: 'ftp://x' }, 'PUBLIC_ORIGIN'],
    [{ ALLOWED_ORIGINS: ' , ' }, 'ALLOWED_ORIGINS'],
    [{ PORT: '70000' }, 'PORT'],
    [{ AUTH_MODE: 'none' }, 'AUTH_MODE'],
    [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
  ])('rejects %j', (override, message) => {
    expect(issues({ ...env, ...override })).toContain(message);
  });

  it('never echoes values in the error description', () => {
    expect(issues({ ...env, DATABASE_URL: 'mysql://u:s3cret-canary@h/d' })).not.toContain('s3cret-canary');
  });
});
