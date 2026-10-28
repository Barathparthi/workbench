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
import { fileReader, readManagedSettings, type ManagedSettings } from './qe-managed-settings';
import { queryRegistry } from './qe-managed-settings-registry';
import { QeFaviconContribution } from './qe-favicon';
import { bindLocalWebAuth } from './qe-local-web-contribution';
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

/** Stops the process with the one-line message of a configuration error (exit 78). */
function exitOnConfigError(error: unknown): never {
  if (!(error instanceof DomainError)) throw error;
  console.error(`QE Workspace cannot start. ${error.message}`);
  return process.exit(EXIT_CONFIG_ERROR);
}

let managed: ManagedSettings | undefined;

/** The machine's managed settings (qe-managed-settings.ts), read once per process; invalid ones stop it. */
export function managedSettingsOrExit(): ManagedSettings {
  try {
    managed ??= readManagedSettings({
      platform: process.platform,
      readFile: fileReader,
      queryRegistry,
    }).settings;
  } catch (error) {
    exitOnConfigError(error);
  }
  return managed;
}

/**
 * The environment the IDE starts with: the process variables, with the organisation's managed settings on top on a
 * user's machine (desktop and local web — never in a hosted runtime, which the control plane configures).
 */
export function withManagedSettings(
  env: Readonly<Record<string, string | undefined>>,
  target: QeAppTarget,
  settings: () => ManagedSettings,
): Readonly<Record<string, string | undefined>> {
  const hosted = target === 'browser' && env['QE_MODE'] === 'hosted';
  if (hosted) return env;
  const { controlPlaneUrl } = settings();
  return controlPlaneUrl === undefined ? env : { ...env, QE_CONTROL_PLANE_URL: controlPlaneUrl };
}

/**
 * Parses the environment or stops the process with a one-line message. Rethrowing would make Node print
 * the minified bundle line it was thrown from, which hides the message.
 */
export function environmentOrExit(
  target: QeAppTarget,
  env: Readonly<Record<string, string | undefined>> = process.env,
  settings: () => ManagedSettings = managedSettingsOrExit,
): QeEnvironment {
  try {
    return parseQeEnvironment(withManagedSettings(env, target, settings), target);
  } catch (error) {
    return exitOnConfigError(error);
  }
}

// Parsed while the backend container loads: invalid configuration stops the backend from starting.
export default new ContainerModule((bind, _unbind, _isBound, _rebind, _unbindAsync, onActivation) => {
  const environment = environmentOrExit('browser');
  bindQeCoreBackend(bind, environment);
  bindQeTerminalPolicy(onActivation, environment);
  // Local web: nothing is served without the run's sign-in cookie (PHASE_10 §10.6). Hosted mode sits behind the
  // control plane's router, which authenticates every request; the desktop app has its own module.
  if (environment.mode === 'local-web') bindLocalWebAuth(bind);
});
