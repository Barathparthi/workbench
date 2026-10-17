import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { CommandContribution } from '@theia/core/lib/common/command';
import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';
import { ContainerModule, type interfaces } from '@theia/core/shared/inversify';

import { QE_ENVIRONMENT_SERVICE_PATH, QeEnvironmentService } from '../common/qe-environment';
import { qeCorePreferenceSchema } from '../common/qe-preferences';
import { QeCommandContribution } from './qe-commands';
import { QeStatusBarContribution } from './qe-status-bar';

/** Bindings shared by the browser and Electron frontends. */
export function bindQeCoreFrontend(bind: interfaces.Bind): void {
  bind(QeEnvironmentService)
    .toDynamicValue((ctx) =>
      ServiceConnectionProvider.createProxy<QeEnvironmentService>(ctx.container, QE_ENVIRONMENT_SERVICE_PATH),
    )
    .inSingletonScope();
  bind(QeCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(QeCommandContribution);
  bind(QeStatusBarContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(QeStatusBarContribution);
  bind(PreferenceContribution).toConstantValue({ schema: qeCorePreferenceSchema });
}

export default new ContainerModule((bind) => {
  bindQeCoreFrontend(bind);
});
