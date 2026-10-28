import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { DomainError } from '@qe/domain';

/**
 * Reads one registry key with Windows' own `reg.exe` (ADR-013: Node has no registry API). The only process this
 * extension starts: fixed arguments, no shell, the 64-bit view, a timeout, read-only. Runs once at startup.
 */
export function queryRegistry(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // The system's reg.exe, never one found on PATH.
  const reg = join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe');
  const result = spawnSync(reg, ['query', key, '/reg:64'], {
    shell: false,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new DomainError('INVALID_REQUEST', `Managed settings in ${key} cannot be read`, {
      cause: result.error,
    });
  }
  // reg.exe exits with 1 when the key does not exist: this machine has no managed settings.
  if (result.status === 1) return undefined;
  if (result.status !== 0) {
    throw new DomainError('INVALID_REQUEST', `Managed settings in ${key} cannot be read`);
  }
  return result.stdout;
}
