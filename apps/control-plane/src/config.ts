import { z } from 'zod';

const postgresUrl = z
  .string()
  .refine(
    (v) => URL.canParse(v) && ['postgres:', 'postgresql:'].includes(new URL(v).protocol),
    'must be a postgres:// URL',
  );

const Config = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    DATABASE_URL: postgresUrl,
    PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }),
    ALLOWED_ORIGINS: z
      .string()
      .transform((s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.url({ protocol: /^https?$/ })).min(1)),
    AUTH_MODE: z.enum(['oidc', 'dev']),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(30_000),
    RUNTIME_KIND: z.enum(['kubernetes', 'docker', 'local']).default('docker'),
    BUILD_VERSION: z.string().default('0.0.0-dev'),
    BUILD_COMMIT: z.string().default('unknown'),
    BUILD_TIME: z.string().default('unknown'),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.AUTH_MODE === 'dev') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'AUTH_MODE=dev is forbidden in production',
      });
    }
  });

export type Config = z.infer<typeof Config>;

/** Parses the environment; throws a ZodError whose issues name variables, never their values. */
export const loadConfig = (env: Readonly<Record<string, string | undefined>> = process.env): Config =>
  Config.parse(env);

/** One line per problem, for startup errors: variable and reason only. */
export function describeConfigError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`).join('; ');
}
