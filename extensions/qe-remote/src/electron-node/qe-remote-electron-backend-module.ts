import { environmentOrExit } from '@qe/theia-qe-core/lib/node/qe-core-backend-module';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';

import { DESKTOP_ACCOUNT_PATH } from '../common/desktop-account-protocol';
import { bindEmbeddedBroker } from '../node/qe-remote-backend-module';
import { DesktopAccount } from './desktop-account';
import { desktopHostClient, takeDesktopHostAddress } from './desktop-host-client';

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
});
