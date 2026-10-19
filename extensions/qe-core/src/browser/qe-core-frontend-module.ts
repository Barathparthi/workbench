import { AboutDialog } from '@theia/core/lib/browser/about-dialog';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { CommandContribution } from '@theia/core/lib/common/command';
import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';
import { ContainerModule, type interfaces } from '@theia/core/shared/inversify';
import { GettingStartedWidget } from '@theia/getting-started/lib/browser/getting-started-widget';

import { QE_ENVIRONMENT_SERVICE_PATH, QeEnvironmentService } from '../common/qe-environment';
import { qeCorePreferenceSchema } from '../common/qe-preferences';
import { QeAboutDialog } from './qe-about-dialog';
import { QeCommandContribution } from './qe-commands';
import { QeStatusBarContribution } from './qe-status-bar';
import { QeUserStatusContribution } from './qe-user-status';
import { QeWelcomeWidget } from './qe-welcome-widget';

/** Bindings shared by the browser and Electron frontends. */
export function bindQeCoreFrontend(bind: interfaces.Bind, rebind: interfaces.Rebind): void {
  bind(QeEnvironmentService)
    .toDynamicValue((ctx) =>
      ServiceConnectionProvider.createProxy<QeEnvironmentService>(ctx.container, QE_ENVIRONMENT_SERVICE_PATH),
    )
    .inSingletonScope();
  bind(QeCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(QeCommandContribution);
  bind(QeStatusBarContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(QeStatusBarContribution);
  bind(QeUserStatusContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(QeUserStatusContribution);
  bind(CommandContribution).toService(QeUserStatusContribution);
  bind(PreferenceContribution).toConstantValue({ schema: qeCorePreferenceSchema });
  // Branding: Theia's About dialog (titled with the application name) and welcome page, with QE content.
  rebind(AboutDialog).to(QeAboutDialog).inSingletonScope();
  rebind(GettingStartedWidget).to(QeWelcomeWidget);
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bindQeCoreFrontend(bind, rebind);
});
