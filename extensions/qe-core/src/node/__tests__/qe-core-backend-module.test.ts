import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  featuresFor,
  QE_ENVIRONMENT_SERVICE_PATH,
  QeEnvironmentService,
  type QeEnvironment,
} from '../../common/qe-environment';
import { bindQeCoreBackend, environmentOrExit, EXIT_CONFIG_ERROR } from '../qe-core-backend-module';

const environment: QeEnvironment = { mode: 'local-web', features: featuresFor('local-web', undefined) };

function containerWith(env: QeEnvironment): Container {
  const container = new Container();
  container.load(
    new ContainerModule((bind) => {
      bindQeCoreBackend(bind, env);
    }),
  );
  return container;
}

describe('bindQeCoreBackend', () => {
  it('serves the startup environment through QeEnvironmentService', async () => {
    await expect(
      containerWith(environment).get<QeEnvironmentService>(QeEnvironmentService).getEnvironment(),
    ).resolves.toEqual(environment);
  });

  it('exposes the service to the frontend on the QE environment RPC path', () => {
    const handlers = containerWith(environment).getAll<ConnectionHandler>(ConnectionHandler);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toBeInstanceOf(RpcConnectionHandler);
    expect(handlers[0]?.path).toBe(QE_ENVIRONMENT_SERVICE_PATH);
  });
});

describe('environmentOrExit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the parsed environment when the configuration is valid', () => {
    expect(environmentOrExit('electron', {}).mode).toBe('desktop');
  });

  it('prints one line and exits with EX_CONFIG on invalid configuration', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => environmentOrExit('browser', { QE_MODE: 'hosted' })).toThrow('exit called');
    expect(exit).toHaveBeenCalledWith(EXIT_CONFIG_ERROR);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'QE Workspace cannot start. Invalid QE Workspace environment: QE_CONTROL_PLANE_URL is required in hosted mode; QE_WORKSPACE_ID is required in hosted mode',
    );
  });
});
