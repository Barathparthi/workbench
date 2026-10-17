import { describe, expect, it } from 'vitest';

import {
  DomainError,
  ErrorCodes,
  ErrorHttpStatus,
  assertNever,
  isDomainError,
  isErrorCode,
  type ErrorCode,
} from '../index.js';

describe('ErrorCodes', () => {
  it('has no duplicates', () => {
    expect(new Set(ErrorCodes).size).toBe(ErrorCodes.length);
  });

  it('maps every code to an HTTP error status', () => {
    for (const code of ErrorCodes) {
      const status = ErrorHttpStatus[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
    expect(Object.keys(ErrorHttpStatus).sort()).toEqual([...ErrorCodes].sort());
  });

  it.each<[ErrorCode, number]>([
    ['AUTH_REQUIRED', 401],
    ['NOT_FOUND', 404],
    ['TARGET_NOT_ALLOWED', 403],
    ['HOST_KEY_MISMATCH', 502],
    ['SSH_TIMEOUT', 504],
    ['SESSION_REVOKED', 410],
    ['REMOTE_FILE_TOO_LARGE', 413],
    ['INTERNAL_ERROR', 500],
  ])('maps %s to %i as in 05_API_CONTRACTS §3', (code, status) => {
    expect(ErrorHttpStatus[code]).toBe(status);
  });
});

describe('isErrorCode', () => {
  it('accepts known codes', () => {
    expect(isErrorCode('HOST_KEY_UNKNOWN')).toBe(true);
  });

  it.each([undefined, null, 42, '', 'host_key_unknown', 'TOTALLY_MADE_UP', {}])('rejects %j', (value) => {
    expect(isErrorCode(value)).toBe(false);
  });
});

describe('DomainError', () => {
  it('carries code, default status and the code as default message', () => {
    const err = new DomainError('PATH_OUTSIDE_ROOT');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DomainError');
    expect(err.code).toBe('PATH_OUTSIDE_ROOT');
    expect(err.httpStatus).toBe(403);
    expect(err.message).toBe('PATH_OUTSIDE_ROOT');
    expect(err.details).toBeUndefined();
    expect(isDomainError(err)).toBe(true);
  });

  it('accepts a message, details, status override and cause', () => {
    const cause = new Error('socket hang up');
    const err = new DomainError('QUOTA_EXCEEDED', 'Workspace quota reached', {
      details: { limit: 3 },
      httpStatus: 409,
      cause,
    });
    expect(err.message).toBe('Workspace quota reached');
    expect(err.details).toEqual({ limit: 3 });
    expect(err.httpStatus).toBe(409);
    expect(err.cause).toBe(cause);
  });

  it('is not confused with plain errors', () => {
    expect(isDomainError(new Error('INTERNAL_ERROR'))).toBe(false);
    expect(isDomainError({ code: 'INTERNAL_ERROR' })).toBe(false);
  });
});

describe('assertNever', () => {
  it('throws when reached at runtime', () => {
    expect(() => assertNever('unexpected' as never)).toThrow('Unexpected value: unexpected');
  });
});
