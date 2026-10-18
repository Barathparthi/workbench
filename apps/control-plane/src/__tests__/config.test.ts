import type { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';

import { describeConfigError, loadConfig, oidcSettings } from '../config.js';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://qews_app_login:s3cret-canary@localhost:5432/qews',
  PUBLIC_ORIGIN: 'http://localhost:8080',
  ALLOWED_ORIGINS: 'http://localhost:3000, http://localhost:8080',
  AUTH_MODE: 'dev',
};

const oidcEnv = {
  ...env,
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'http://localhost:8081/realms/qe',
  OIDC_CLIENT_ID: 'qe-workspace',
  OIDC_CLIENT_SECRET: 'client-secret-canary',
  OIDC_REDIRECT_URL: 'http://localhost:8080/auth/callback',
  SESSION_SECRET: 'x'.repeat(32),
  COOKIE_SECURE: 'false',
};

const prodOidc = {
  ...oidcEnv,
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://qe.example',
  ALLOWED_ORIGINS: 'https://qe.example',
  OIDC_ISSUER: 'https://idp.example/realms/qe',
  OIDC_REDIRECT_URL: 'https://qe.example/auth/callback',
  COOKIE_SECURE: 'true',
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
    expect(issues({ ...env, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://qe.example' })).toBe(
      'AUTH_MODE: AUTH_MODE=dev is forbidden in production',
    );
    expect(loadConfig({ ...prodOidc }).AUTH_MODE).toBe('oidc');
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

describe('OIDC and session configuration', () => {
  it('requires the IdP settings and a session secret in oidc mode', () => {
    const message = issues({ ...env, AUTH_MODE: 'oidc' });
    for (const key of [
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_REDIRECT_URL',
      'SESSION_SECRET',
    ]) {
      expect(message).toContain(`${key}: required when AUTH_MODE=oidc`);
    }
  });

  it('builds the OIDC settings with defaults', () => {
    const s = oidcSettings(loadConfig(oidcEnv));
    expect(s).toMatchObject({
      issuer: 'http://localhost:8081/realms/qe',
      scopes: 'openid profile email',
      groupsClaim: 'groups',
      roleMappings: {},
      idleMs: 30 * 60_000,
      absoluteMs: 8 * 3_600_000,
      cookieSecure: false,
      publicOrigin: 'http://localhost:8080',
      allowInsecureIssuer: true,
    });
  });

  it('refuses oidcSettings outside oidc mode', () => {
    expect(() => oidcSettings(loadConfig(env))).toThrow(/not a complete oidc/);
  });

  it('parses role mappings and refuses unknown roles', () => {
    const c = loadConfig({ ...oidcEnv, ROLE_MAPPINGS: '{"qe-users":["qe.user"],"qe-lab-a":["lab.a.user"]}' });
    expect(c.ROLE_MAPPINGS).toEqual({ 'qe-users': ['qe.user'], 'qe-lab-a': ['lab.a.user'] });
    expect(issues({ ...oidcEnv, ROLE_MAPPINGS: '{"g":["root"]}' })).toContain(
      'ROLE_MAPPINGS: invalid role mappings',
    );
    expect(issues({ ...oidcEnv, ROLE_MAPPINGS: 'not json' })).toContain('ROLE_MAPPINGS');
  });

  it.each([
    [{ SESSION_SECRET: 'short' }, 'SESSION_SECRET'],
    [{ OIDC_SCOPES: 'profile email' }, 'OIDC_SCOPES: must include openid'],
    [{ SESSION_IDLE_MINUTES: '0' }, 'SESSION_IDLE_MINUTES'],
    [{ SESSION_ABSOLUTE_HOURS: '1000' }, 'SESSION_ABSOLUTE_HOURS'],
    [{ COOKIE_SECURE: 'yes' }, 'COOKIE_SECURE'],
    [{ DEV_ROLES: 'root' }, 'DEV_ROLES'],
  ])('rejects %j', (override, message) => {
    expect(issues({ ...oidcEnv, ...override })).toContain(message);
  });

  it('requires https and secure cookies in production', () => {
    const message = issues({
      ...prodOidc,
      PUBLIC_ORIGIN: 'http://qe.example',
      OIDC_ISSUER: 'http://idp.example',
      OIDC_REDIRECT_URL: 'http://qe.example/auth/callback',
      COOKIE_SECURE: 'false',
    });
    expect(message).toContain('COOKIE_SECURE: must be true in production');
    expect(message).toContain('PUBLIC_ORIGIN: must be https in production');
    expect(message).toContain('OIDC_ISSUER: must be https in production');
    expect(message).toContain('OIDC_REDIRECT_URL: must be https in production');
    expect(oidcSettings(loadConfig(prodOidc)).allowInsecureIssuer).toBe(false);
  });

  it('never echoes secret values in errors', () => {
    const message = issues({ ...oidcEnv, NODE_ENV: 'production' });
    expect(message).not.toContain('client-secret-canary');
    expect(message).not.toContain('x'.repeat(32));
  });
});
