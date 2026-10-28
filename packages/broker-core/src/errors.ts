import type { ErrorCode } from '@qe/domain';

import type { HostKeyOutcome } from './host-key.js';

/** The error shapes ssh2 and Node sockets produce (S4 report §6). */
interface SshErrorLike {
  readonly level?: string;
  readonly code?: string;
  readonly message?: string;
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EHOSTDOWN',
  'ENOTFOUND',
]);

/**
 * Maps a failed connect to an API error code (05_API_CONTRACTS §3). The host-key outcome is decided by our own
 * verifier, so a handshake failure after a refused key is reported as the key problem, never as "unreachable".
 */
export function mapSshError(error: unknown, hostKey: HostKeyOutcome | undefined): ErrorCode {
  if (hostKey === 'mismatch' || hostKey === 'revoked') return 'HOST_KEY_MISMATCH';
  if (hostKey === 'unknown') return 'HOST_KEY_UNKNOWN';
  const e = (typeof error === 'object' && error !== null ? error : {}) as SshErrorLike;
  if (e.level === 'client-authentication') return 'CREDENTIALS_REJECTED';
  if (e.level === 'client-timeout' || e.code === 'ETIMEDOUT') return 'SSH_TIMEOUT';
  if (e.level === 'client-socket' || (e.code !== undefined && UNREACHABLE.has(e.code)))
    return 'SSH_UNREACHABLE';
  return 'INTERNAL_ERROR';
}

/** Short, user-facing explanations (04_OPERATIONS/USER_GUIDE troubleshooting); never internal detail. */
export function messageFor(code: ErrorCode): string {
  switch (code) {
    case 'HOST_KEY_MISMATCH':
      return 'The remote system presented an unexpected host key. Do not retry; contact the lab admin.';
    case 'HOST_KEY_UNKNOWN':
      return 'The remote system has no approved host key yet.';
    case 'CREDENTIALS_REJECTED':
      return 'The remote system refused the credentials.';
    case 'CREDENTIALS_UNAVAILABLE':
      return 'Credentials are not available right now. Try again later.';
    case 'SSH_TIMEOUT':
      return 'The remote system did not answer in time.';
    case 'SSH_UNREACHABLE':
      return 'The remote system cannot be reached.';
    case 'TARGET_ADDRESS_FORBIDDEN':
    case 'TARGET_NOT_ALLOWED':
      return 'This connection is not allowed by policy.';
    default:
      return 'The remote session could not be opened.';
  }
}
