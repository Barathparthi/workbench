import { describe, expect, it } from 'vitest';

import { requestIdFor } from '../request-id.js';

describe('requestIdFor', () => {
  it('keeps a well-formed incoming id', () => {
    expect(requestIdFor({ headers: { 'x-request-id': 'b5c1-4e2a-9f00' } })).toBe('b5c1-4e2a-9f00');
  });

  it.each(['short', 'x'.repeat(65), 'has spaces in it', 'semi;colon-1234', '<script>alert(1)</script>'])(
    'replaces %j with a fresh UUID',
    (incoming) => {
      expect(requestIdFor({ headers: { 'x-request-id': incoming } })).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('generates one when absent', () => {
    expect(requestIdFor({ headers: {} })).toMatch(/^[0-9a-f-]{36}$/);
  });
});
