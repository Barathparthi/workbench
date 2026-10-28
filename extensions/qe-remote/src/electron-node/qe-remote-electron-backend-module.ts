import { environmentOrExit } from '@qe/theia-qe-core/lib/node/qe-core-backend-module';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';

import { DESKTOP_ACCOUNT_PATH } from '../common/desktop-account-protocol';
import { MANAGED_RELAY_PATH, type StreamClient } from '../common/managed-relay-protocol';
import { bindEmbeddedBroker } from '../node/qe-remote-backend-module';
import { DesktopAccount } from './desktop-account';
import { desktopHostClient, takeDesktopHostAddress } from './desktop-host-client';
import { ManagedRelay } from './managed-relay';

// The desktop app's backend runs on the user's machine: personal targets are always available (ADR-008), and managed
// ones once the user signs in to the configured control plane (PHASE_10 §10.4). One sign-in for every window.
export default new ContainerModule((bind) => {
  bindEmbeddedBroker(bind);

  const host = takeDesktopHostAddress();
  bind(DesktopAccount)
    .toDynamicValue(
      () =>
        new DesktopAccount({
          controlPlaneUrl: environmentOrExit('electron').controlPlaneUrl,
          host: host === undefined ? undefined : desktopHostClient(host),
        }),
    )
    .inSingletonScope();
  bind(ConnectionHandler)
    .toDynamicValue(
      (ctx) => new RpcConnectionHandler(DESKTOP_ACCOUNT_PATH, () => ctx.container.get(DesktopAccount)),
    )
    .inSingletonScope();

  // Managed targets through the backend, one relay per window, only with a control plane to relay to.
  const controlPlaneUrl = environmentOrExit('electron').controlPlaneUrl;
  if (controlPlaneUrl !== undefined) {
    bind(ConnectionHandler)
      .toDynamicValue(
        (ctx) =>
          new RpcConnectionHandler<StreamClient>(MANAGED_RELAY_PATH, (client) => {
            const account = ctx.container.get(DesktopAccount);
            const relay = new ManagedRelay({ controlPlaneUrl, accessToken: () => account.accessToken() });
            relay.setClient(client);
            client.onDidCloseConnection(() => {
              relay.dispose();
            });
            return relay;
          }),
      )
      .inSingletonScope();
  }
});
