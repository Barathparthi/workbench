import { environmentOrExit, managedSettingsOrExit } from '@qe/theia-qe-core/lib/node/qe-core-backend-module';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule, type interfaces } from '@theia/core/shared/inversify';

import { EMBEDDED_BROKER_PATH, type EmbeddedBrokerClient } from '../common/embedded-broker-protocol';
import { EmbeddedBroker } from './embedded-broker';
import { localBrokerDeps } from './local-broker-deps';

/** One embedded broker per IDE window, over Theia's RPC channel; it ends when the window's connection closes. */
export function bindEmbeddedBroker(bind: interfaces.Bind): void {
  bind(ConnectionHandler)
    .toDynamicValue(
      () =>
        new RpcConnectionHandler<EmbeddedBrokerClient>(EMBEDDED_BROKER_PATH, (client) => {
          const broker = new EmbeddedBroker(localBrokerDeps(managedSettingsOrExit()));
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
