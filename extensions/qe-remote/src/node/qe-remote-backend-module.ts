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
import { environmentOrExit } from '@qe/theia-qe-core/lib/node/qe-core-backend-module';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule, type interfaces } from '@theia/core/shared/inversify';

import { EMBEDDED_BROKER_PATH, type EmbeddedBrokerClient } from '../common/embedded-broker-protocol';
import { EmbeddedBroker, type EmbeddedBrokerDeps } from './embedded-broker';

/** The embedded broker's sources on this machine: the user's SSH files and QE's own under `~/.qe-workspace`. */
export function localBrokerDeps(home: string = homedir()): EmbeddedBrokerDeps {
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
    deniedCidrs: [], // the organisation's deny list arrives with managed settings (Phase 10.6)
    home,
    agent: detectAgent(),
  };
}

/** One embedded broker per IDE window, over Theia's RPC channel; it ends when the window's connection closes. */
export function bindEmbeddedBroker(bind: interfaces.Bind): void {
  bind(ConnectionHandler)
    .toDynamicValue(
      () =>
        new RpcConnectionHandler<EmbeddedBrokerClient>(EMBEDDED_BROKER_PATH, (client) => {
          const broker = new EmbeddedBroker(localBrokerDeps());
          broker.setClient(client);
          client.onDidCloseConnection(() => {
            broker.dispose();
          });
          return broker;
        }),
    )
    .inSingletonScope();
}

// The browser app serves hosted workspaces too: there the runtime must never reach SSH targets itself (rules 2, 3;
// managed targets go through the hosted broker), so the embedded broker exists only in local-web mode.
export default new ContainerModule((bind) => {
  if (environmentOrExit('browser').features.personalTargets) bindEmbeddedBroker(bind);
});
