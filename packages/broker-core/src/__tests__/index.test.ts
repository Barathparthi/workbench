import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../index.js';

describe('@qe/broker-core', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qe/broker-core');
  });
});
