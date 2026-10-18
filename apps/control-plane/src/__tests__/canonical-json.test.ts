import { describe, expect, it } from 'vitest';

import { eventHash } from '../audit/audit-writer.js';
import { canonicalJson } from '../audit/canonical-json.js';

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson(new Date('2026-10-18T00:00:00Z'))).toBe('"2026-10-18T00:00:00.000Z"');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('eventHash', () => {
  const fields = {
    id: 'e1',
    occurredAt: new Date('2026-10-18T00:00:00Z'),
    actorUserId: null,
    actorType: 'system',
    action: 'WORKSPACE_CREATE',
    resourceType: 'workspace',
    resourceId: 'w1',
    result: 'success',
    reasonCode: null,
    requestId: null,
    metadata: { name: 'a', templateId: 't' },
  };

  it('is deterministic and depends on the previous hash and every field', () => {
    const first = eventHash(null, fields);
    expect(eventHash(null, { ...fields, metadata: { templateId: 't', name: 'a' } })).toEqual(first);
    expect(eventHash(first, fields)).not.toEqual(first);
    expect(eventHash(null, { ...fields, result: 'denied' })).not.toEqual(first);
  });
});
