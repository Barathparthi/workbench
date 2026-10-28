import { describe, expect, it } from 'vitest';

import { localBrokerDeps } from '../local-broker-deps';

describe('localBrokerDeps', () => {
  it('applies the organisation’s managed settings: its deny list, and whether unknown host keys may be trusted', () => {
    const deps = localBrokerDeps(
      {
        deniedCidrs: ['10.0.0.0/8', 'fd00::/8'],
        trustOnFirstUse: false,
      },
      '/home/someone',
    );
    expect(deps.deniedCidrs).toEqual(['10.0.0.0/8', 'fd00::/8']);
    expect(deps.trustOnFirstUse).toBe(false);
  });

  it('allows trust on first use and denies nothing extra without managed settings', () => {
    const deps = localBrokerDeps({}, '/home/someone');
    expect(deps.deniedCidrs).toEqual([]);
    expect(deps.trustOnFirstUse).toBe(true);
  });
});
