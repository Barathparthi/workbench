/**
 * Error vocabulary shared by every service and client.
 * Codes and HTTP statuses are the contract of record in 01_ARCHITECTURE/05_API_CONTRACTS.md §3.
 */
export const ErrorCodes = [
  'AUTH_REQUIRED',
  'CSRF_REJECTED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_REQUEST',
  'CONFLICT',
  'WORKSPACE_NOT_READY',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'TARGET_NOT_ALLOWED',
  'TARGET_ADDRESS_FORBIDDEN',
  'HOST_KEY_UNKNOWN',
  'HOST_KEY_MISMATCH',
  'CREDENTIALS_UNAVAILABLE',
  'CREDENTIALS_REJECTED',
  'SSH_TIMEOUT',
  'SSH_UNREACHABLE',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'PATH_OUTSIDE_ROOT',
  'REMOTE_FILE_TOO_LARGE',
  'REMOTE_FILE_CONFLICT',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ErrorCodes)[number];

/**
 * Default HTTP status per code. QUOTA_EXCEEDED is documented as 429/409; 429 is the default and a
 * route may override it via DomainError options when the quota is a state conflict.
 */
export const ErrorHttpStatus: Readonly<Record<ErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  CSRF_REJECTED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  CONFLICT: 409,
  WORKSPACE_NOT_READY: 409,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  TARGET_NOT_ALLOWED: 403,
  TARGET_ADDRESS_FORBIDDEN: 403,
  HOST_KEY_UNKNOWN: 502,
  HOST_KEY_MISMATCH: 502,
  CREDENTIALS_UNAVAILABLE: 503,
  CREDENTIALS_REJECTED: 502,
  SSH_TIMEOUT: 504,
  SSH_UNREACHABLE: 502,
  SESSION_EXPIRED: 410,
  SESSION_REVOKED: 410,
  PATH_OUTSIDE_ROOT: 403,
  REMOTE_FILE_TOO_LARGE: 413,
  REMOTE_FILE_CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

const errorCodeSet: ReadonlySet<string> = new Set(ErrorCodes);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && errorCodeSet.has(value);
}

export interface DomainErrorOptions {
  /** Structured, non-sensitive context. Never put credentials, tokens, file contents or terminal bytes here. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Overrides the default status from ErrorHttpStatus. */
  readonly httpStatus?: number;
  readonly cause?: unknown;
}

/** The only error type services throw on purpose. Never throw strings. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message?: string, options: DomainErrorOptions = {}) {
    super(message ?? code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? ErrorHttpStatus[code];
    this.details = options.details;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

/** Exhaustiveness guard for discriminated unions: `default: return assertNever(x)`. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
