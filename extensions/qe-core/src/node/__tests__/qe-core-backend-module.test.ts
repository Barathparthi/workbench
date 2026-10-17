import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { describe, expect, it } from 'vitest';

import {
  featuresFor,
  QE_ENVIRONMENT_SERVICE_PATH,
  QeEnvironmentService,
  type QeEnvironment,
} from '../../common/qe-environment';
import { bindQeCoreBackend } from '../qe-core-backend-module';

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
