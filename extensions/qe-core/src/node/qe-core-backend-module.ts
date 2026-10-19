import { DomainError } from '@qe/domain';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ILogger } from '@theia/core/lib/common/logger';
import { ContainerModule, type interfaces } from '@theia/core/shared/inversify';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { IShellTerminalServer } from '@theia/terminal/lib/common/shell-terminal-protocol';

import {
  QE_ENVIRONMENT_SERVICE_PATH,
  QeEnvironmentService,
  type QeEnvironment,
} from '../common/qe-environment';
import { parseQeEnvironment, type QeAppTarget } from './qe-environment-config';
import { QeFaviconContribution } from './qe-favicon';
import { enforceTerminalPolicy, terminalPolicyFor, type TerminalServerLike } from './qe-terminal-policy';

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

/**
 * Applies the QE terminal policy (shell allowlist, terminal limit, environment defaults) to Theia's shell
 * terminal server when it is first created — a decoration, so Theia's own wiring of that server stays intact.
 */
export function bindQeTerminalPolicy(
  onActivation: interfaces.Container['onActivation'],
  environment: Pick<QeEnvironment, 'mode'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const policy = terminalPolicyFor(environment, env);
  onActivation<TerminalServerLike>(IShellTerminalServer, (ctx, server) => {
    const processes = ctx.container.get(ProcessManager);
    const logger = ctx.container.get<ILogger>(ILogger);
    return enforceTerminalPolicy(
      server,
      policy,
      (id, onExit) => {
        const process = processes.get(id);
        if (process === undefined || process.killed) {
          onExit();
          return;
        }
        process.onExit(onExit);
        process.onClose(onExit);
      },
      { warn: (message) => void logger.warn(message) },
    );
  });
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
export default new ContainerModule((bind, _unbind, _isBound, _rebind, _unbindAsync, onActivation) => {
  const environment = environmentOrExit('browser');
  bindQeCoreBackend(bind, environment);
  bindQeTerminalPolicy(onActivation, environment);
});
