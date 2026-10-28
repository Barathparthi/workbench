import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';

import { DESKTOP_ACCOUNT_PATH, DesktopAccountService } from '../common/desktop-account-protocol';
import { MANAGED_RELAY_PATH, type ManagedRelayService } from '../common/managed-relay-protocol';
import { bindQeRemoteFrontend } from '../browser/qe-remote-frontend-module';
import { ManagedRelayConnector } from '../browser/qe-remote-files';
import { DesktopAccountContribution } from './desktop-account-contribution';

/**
 * Desktop: the same remote features as the browser app. The renderer runs from `file://`, so it never talks to the
 * hosted control plane or broker itself (risk R17) and holds no token: personal targets go through the embedded
 * broker in the Electron backend, managed targets through the backend's relay once the user has signed in.
 */
export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bindQeRemoteFrontend(bind, rebind);
  bind(ManagedRelayConnector).toDynamicValue(
    (ctx): ManagedRelayConnector =>
      (client) =>
        ServiceConnectionProvider.createProxy<ManagedRelayService>(ctx.container, MANAGED_RELAY_PATH, client),
  );
  bind(DesktopAccountService)
    .toDynamicValue((ctx) =>
      ServiceConnectionProvider.createProxy<DesktopAccountService>(ctx.container, DESKTOP_ACCOUNT_PATH),
    )
    .inSingletonScope();
  bind(DesktopAccountContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(DesktopAccountContribution);
  bind(FrontendApplicationContribution).toService(DesktopAccountContribution);
});
