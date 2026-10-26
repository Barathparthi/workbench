import { hostname } from 'node:os';

import { isValidCidr } from '@qe/policy';
import { z } from 'zod';

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);
const httpUrl = z.url({ protocol: /^https?$/ });

const Config = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8082),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
    /** The control plane's internal API (ticket redeem, state reports). */
    CONTROL_PLANE_INTERNAL_URL: httpUrl,
    /** Shared service token both ways (until mTLS, Phase 16). */
    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    /** Origins the IDE runs on; WebSocket upgrades from anywhere else are refused. */
    ALLOWED_ORIGINS: csv.pipe(z.array(httpUrl).min(1)),
    /** Networks no connection may go to, on top of the built-in denials (same list as the control plane). */
    TARGET_DENY_CIDRS: csv
      .pipe(z.array(z.string().refine(isValidCidr, { message: 'invalid CIDR' })))
      .default([]),
    /** Development only: directory of private key files for `file_dev` credential references. */
    DEV_CREDENTIALS_DIR: z.string().min(1).optional(),
    BROKER_INSTANCE_ID: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/)
      .default(hostname().slice(0, 64) || 'broker'),
    MAX_SESSIONS: z.coerce.number().int().min(1).max(10_000).default(500),
    /** On SIGTERM, live sessions get this long before they are closed with 4013 (clients reconnect elsewhere). */
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10_000),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.DEV_CREDENTIALS_DIR !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_CREDENTIALS_DIR'],
        message: 'development key files are forbidden in production',
      });
    }
    if (c.NODE_ENV === 'production') {
      for (const key of ['CONTROL_PLANE_INTERNAL_URL'] as const) {
        if (!c[key].startsWith('https:'))
          ctx.addIssue({ code: 'custom', path: [key], message: 'must be https in production' });
      }
    }
  });

export type Config = z.infer<typeof Config>;
export const loadConfig = (env: Readonly<Record<string, string | undefined>> = process.env): Config =>
  Config.parse(env);
export const describeConfigError = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`).join('; ');
