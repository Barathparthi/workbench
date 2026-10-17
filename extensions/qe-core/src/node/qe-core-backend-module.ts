import { DomainError } from '@qe/domain';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ContainerModule, type interfaces } from '@theia/core/shared/inversify';

import {
  QE_ENVIRONMENT_SERVICE_PATH,
  QeEnvironmentService,
  type QeEnvironment,
} from '../common/qe-environment';
import { parseQeEnvironment, type QeAppTarget } from './qe-environment-config';
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

/** sysexits.h EX_CONFIG: lets operators (and Kubernetes events) tell bad configuration from a crash. */
export const EXIT_CONFIG_ERROR = 78;

/**
 * Parses the environment or stops the process with a one-line message. Rethrowing would make Node print
 * the minified bundle line it was thrown from, which hides the message.
 */
export function environmentOrExit(
  target: QeAppTarget,
  env: Readonly<Record<string, string | undefined>> = process.env,
): QeEnvironment {
  try {
    return parseQeEnvironment(env, target);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    console.error(`QE Workspace cannot start. ${error.message}`);
    return process.exit(EXIT_CONFIG_ERROR);
  }
}

// Parsed while the backend container loads: invalid configuration stops the backend from starting.
export default new ContainerModule((bind) => {
  bindQeCoreBackend(bind, environmentOrExit('browser'));
});
