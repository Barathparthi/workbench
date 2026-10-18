import { isKnownRole, parseRoleMappings, type RoleMappings } from '@qe/rbac';
import { z } from 'zod';

const postgresUrl = z
  .string()
  .refine(
    (v) => URL.canParse(v) && ['postgres:', 'postgresql:'].includes(new URL(v).protocol),
    'must be a postgres:// URL',
  );

const httpUrl = z.url({ protocol: /^https?$/ });
const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const roleMappings = z.string().transform((text, ctx): RoleMappings => {
  try {
    return parseRoleMappings(text);
  } catch (error) {
    const reason =
      error instanceof z.ZodError
        ? error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join(', ')
        : 'invalid';
    ctx.addIssue({ code: 'custom', message: `invalid role mappings: ${reason}` });
    return z.NEVER;
  }
});

const Config = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    DATABASE_URL: postgresUrl,
    PUBLIC_ORIGIN: httpUrl,
    ALLOWED_ORIGINS: csv.pipe(z.array(httpUrl).min(1)),
    AUTH_MODE: z.enum(['oidc', 'dev']),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(30_000),
    RUNTIME_KIND: z.enum(['kubernetes', 'docker', 'local']).default('docker'),
    BUILD_VERSION: z.string().default('0.0.0-dev'),
    BUILD_COMMIT: z.string().default('unknown'),
    BUILD_TIME: z.string().default('unknown'),

    // Dev mode: roles of the seeded user (AUTH_MODE=dev only).
    DEV_ROLES: csv
      .pipe(z.array(z.string().refine(isKnownRole, { message: 'unknown role' })).min(1))
      .default(['qe.user']),

    // OIDC (required when AUTH_MODE=oidc; Phase 04 against a local Keycloak, Phase 12 the corporate IdP).
    OIDC_ISSUER: httpUrl.optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    /** The control plane's own callback, registered at the IdP: https://<host>/auth/callback */
    OIDC_REDIRECT_URL: httpUrl.optional(),
    OIDC_SCOPES: z.string().default('openid profile email'),
    OIDC_GROUPS_CLAIM: z.string().min(1).default('groups'),
    /** JSON object: IdP group → platform roles. Unmapped groups grant nothing. */
    ROLE_MAPPINGS: roleMappings.default({}),

    // Browser sessions (07_SECURITY §4.1).
    /** Signs the short-lived login transaction cookie. At least 32 characters of randomness. */
    SESSION_SECRET: z.string().min(32).optional(),
    SESSION_IDLE_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(30),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(8),
    /** Secure cookies; only plain-http local development may turn this off. */
    COOKIE_SECURE: bool.default(true),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.AUTH_MODE === 'dev') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'AUTH_MODE=dev is forbidden in production',
      });
    }
    if (c.AUTH_MODE === 'oidc') {
      for (const key of [
        'OIDC_ISSUER',
        'OIDC_CLIENT_ID',
        'OIDC_CLIENT_SECRET',
        'OIDC_REDIRECT_URL',
        'SESSION_SECRET',
      ] as const) {
        if (c[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'required when AUTH_MODE=oidc' });
        }
      }
      if (!c.OIDC_SCOPES.split(/\s+/).includes('openid')) {
        ctx.addIssue({ code: 'custom', path: ['OIDC_SCOPES'], message: 'must include openid' });
      }
    }
    if (c.NODE_ENV === 'production') {
      if (!c.COOKIE_SECURE) {
        ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'must be true in production' });
      }
      for (const key of ['PUBLIC_ORIGIN', 'OIDC_ISSUER', 'OIDC_REDIRECT_URL'] as const) {
        const value = c[key];
        if (value !== undefined && new URL(value).protocol !== 'https:') {
          ctx.addIssue({ code: 'custom', path: [key], message: 'must be https in production' });
        }
      }
    }
  });

export type Config = z.infer<typeof Config>;

/** The OIDC settings, present exactly when AUTH_MODE=oidc (guaranteed by the schema). */
export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUrl: string;
  readonly scopes: string;
  readonly groupsClaim: string;
  readonly roleMappings: RoleMappings;
  readonly sessionSecret: string;
  readonly idleMs: number;
  readonly absoluteMs: number;
  readonly cookieSecure: boolean;
  /** Where the browser lands after login: PUBLIC_ORIGIN + a validated relative path. */
  readonly publicOrigin: string;
  /** Plain-http issuers are allowed only outside production (local Keycloak). */
  readonly allowInsecureIssuer: boolean;
}

export function oidcSettings(c: Config): OidcSettings {
  if (
    c.AUTH_MODE !== 'oidc' ||
    c.OIDC_ISSUER === undefined ||
    c.OIDC_CLIENT_ID === undefined ||
    c.OIDC_CLIENT_SECRET === undefined ||
    c.OIDC_REDIRECT_URL === undefined ||
    c.SESSION_SECRET === undefined
  ) {
    throw new Error('OIDC settings requested but AUTH_MODE is not a complete oidc configuration');
  }
  return {
    issuer: c.OIDC_ISSUER,
    clientId: c.OIDC_CLIENT_ID,
    clientSecret: c.OIDC_CLIENT_SECRET,
    redirectUrl: c.OIDC_REDIRECT_URL,
    scopes: c.OIDC_SCOPES,
    groupsClaim: c.OIDC_GROUPS_CLAIM,
    roleMappings: c.ROLE_MAPPINGS,
    sessionSecret: c.SESSION_SECRET,
    idleMs: c.SESSION_IDLE_MINUTES * 60_000,
    absoluteMs: c.SESSION_ABSOLUTE_HOURS * 3_600_000,
    cookieSecure: c.COOKIE_SECURE,
    publicOrigin: new URL(c.PUBLIC_ORIGIN).origin,
    allowInsecureIssuer: c.NODE_ENV !== 'production',
  };
}

/** Parses the environment; throws a ZodError whose issues name variables, never their values. */
export const loadConfig = (env: Readonly<Record<string, string | undefined>> = process.env): Config =>
  Config.parse(env);

/** One line per problem, for startup errors: variable and reason only. */
export function describeConfigError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`).join('; ');
}
