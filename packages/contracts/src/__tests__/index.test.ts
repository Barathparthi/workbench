import { describe, expect, it } from 'vitest';

import { ErrorCodes, ErrorHttpStatus, PACKAGE_NAME } from '../index.js';

describe('@qe/contracts', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qe/contracts');
  });

  it('re-exports the domain error vocabulary for problem+json bodies', () => {
    expect(ErrorCodes).toContain('TARGET_NOT_ALLOWED');
    expect(ErrorHttpStatus.TARGET_NOT_ALLOWED).toBe(403);
  });
});
