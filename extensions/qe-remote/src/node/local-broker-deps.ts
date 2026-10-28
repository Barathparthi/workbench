import { lookup } from 'node:dns/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  detectAgent,
  knownHostsStore,
  localAuditLog,
  ssh2Transport,
  sshConfigTargetSource,
} from '@qe/broker-core';

import type { EmbeddedBrokerDeps } from './embedded-broker';

/** What the embedded broker takes from the organisation's managed settings (qe-core, ADR-013). */
export interface BrokerPolicy {
  readonly deniedCidrs?: readonly string[] | undefined;
  readonly trustOnFirstUse?: boolean | undefined;
}

/**
 * The embedded broker's sources on this machine: the user's SSH files and QE's own under `~/.qe-workspace`; the
 * organisation's deny list and trust-on-first-use switch from its managed settings.
 */
export function localBrokerDeps(policy: BrokerPolicy, home: string = homedir()): EmbeddedBrokerDeps {
  const qe = join(home, '.qe-workspace');
  return {
    targets: sshConfigTargetSource({ home, localUser: userInfo().username }),
    hostKeys: knownHostsStore({
      files: [join(home, '.ssh', 'known_hosts'), join(qe, 'known_hosts')],
      saveTo: join(qe, 'known_hosts'),
    }),
    audit: localAuditLog({ path: join(qe, 'audit.log') }),
    transport: ssh2Transport,
    resolver: async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
    deniedCidrs: [...(policy.deniedCidrs ?? [])],
    trustOnFirstUse: policy.trustOnFirstUse ?? true,
    home,
    agent: detectAgent(),
  };
}
