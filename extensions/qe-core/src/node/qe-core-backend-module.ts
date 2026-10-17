import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ContainerModule, type interfaces } from '@theia/core/shared/inversify';

import {
  QE_ENVIRONMENT_SERVICE_PATH,
  QeEnvironmentService,
  type QeEnvironment,
} from '../common/qe-environment';
import { parseQeEnvironment } from './qe-environment-config';
import { QeFaviconContribution } from './qe-favicon';

/** Serves the environment, derived once at startup, to the frontend over Theia's authenticated RPC channel. */
export function bindQeCoreBackend(bind: interfaces.Bind, environment: QeEnvironment): void {
  const service: QeEnvironmentService = { getEnvironment: () => Promise.resolve(environment) };
  bind(QeEnvironmentService).toConstantValue(service);
  bind(ConnectionHandler)
    .toDynamicValue(
      (ctx) =>
        new RpcConnectionHandler(QE_ENVIRONMENT_SERVICE_PATH, () =>
          ctx.container.get<QeEnvironmentService>(QeEnvironmentService),
        ),
    )
    .inSingletonScope();
  bind(QeFaviconContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(QeFaviconContribution);
}

// Parsed while the backend container loads: invalid configuration stops the backend from starting.
export default new ContainerModule((bind) => {
  bindQeCoreBackend(bind, parseQeEnvironment(process.env, 'browser'));
});
