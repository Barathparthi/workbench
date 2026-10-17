import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../index.js';

describe('@qe/test-utils', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qe/test-utils');
  });
});
