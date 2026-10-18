import type { LoggerOptions } from 'pino';

/** Values that must never reach logs (CLAUDE.md rule 4; T17). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.privateKey',
  '*.passphrase',
  '*.token',
  '*.ticket',
  '*.secret',
  '*.authorization',
  '*.cookie',
];

export function loggerOptions(level: string): LoggerOptions {
  return { level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } };
}
