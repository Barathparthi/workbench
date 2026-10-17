import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../index.js';

describe('@qe/runtime-providers', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qe/runtime-providers');
  });
});
