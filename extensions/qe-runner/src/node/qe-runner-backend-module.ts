import { ILogger } from '@theia/core/lib/common/logger';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';

import { QE_RUNNER_PATH, type QeRunnerClient } from '../common/qe-runner-protocol';
import { RunnerService, runnerOptionsFrom } from './runner-service';

/**
 * One runner per IDE backend — the workspace runtime (hosted), the local-web container or the desktop app — shared by
 * every page, so the limit on concurrent runs counts them all; each page hears every run.
 */
export default new ContainerModule((bind) => {
  bind(RunnerService)
    .toDynamicValue((ctx) => {
      const logger = ctx.container.get<ILogger>(ILogger);
      return new RunnerService({
        options: runnerOptionsFrom(process.env),
        log: { warn: (message) => void logger.warn(message) },
      });
    })
    .inSingletonScope();
  bind(ConnectionHandler)
    .toDynamicValue(
      (ctx) =>
        new RpcConnectionHandler<QeRunnerClient>(QE_RUNNER_PATH, (client) => {
          const runner = ctx.container.get(RunnerService);
          runner.setClient(client);
          client.onDidCloseConnection(() => {
            runner.removeClient(client);
          });
          return runner;
        }),
    )
    .inSingletonScope();
});
