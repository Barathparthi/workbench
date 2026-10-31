import type { TestRunResultRequest } from '@qe/contracts';
import type {
  QeRemoteTestRunner,
  RemoteTestRequest,
  RemoteTestRun,
  RemoteTestRunEvents,
  RemoteTestSystem,
} from '@qe/theia-qe-core/lib/common/qe-remote-tests';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';

import type { RemoteTarget, TerminalSink } from '../common/connection-client';
import { describeFailure } from '../common/remote-client';
import { remoteRootUri } from '../common/remote-files';
import { QeRemoteServices, RemoteTargetNames } from './qe-remote-files';

/** What an exec stream's text frames say about the run (the broker's `run` and `error` messages). */
function control(frame: string): { result?: TestRunResultRequest; problem?: string } {
  try {
    const message = JSON.parse(frame) as {
      t?: unknown;
      result?: unknown;
      problem?: unknown;
      message?: unknown;
    };
    if (message.t === 'run' && typeof message.result === 'object' && message.result !== null) {
      return {
        result: message.result as TestRunResultRequest,
        ...(typeof message.problem === 'string' && { problem: message.problem }),
      };
    }
    if (message.t === 'error' && typeof message.message === 'string') return { problem: message.message };
  } catch {
    // Not a control message the panel needs.
  }
  return {};
}

/**
 * Test runs on remote systems for the QE Tests panel (qe-core's `QeRemoteTestRunner`): the same connection client as
 * terminals and remote folders — managed targets through the control plane and broker (hosted, or the desktop app's
 * relay), personal hosts through the embedded broker. A run streams like a terminal; its `run` message carries the
 * result as recorded, and the panel's Cancel is the terminal's interrupt.
 */
@injectable()
export class QeRemoteTestRunnerImpl implements QeRemoteTestRunner {
  @inject(QeRemoteServices) protected readonly services!: QeRemoteServices;
  @inject(RemoteTargetNames) protected readonly names!: RemoteTargetNames;
  protected readonly known = new Map<string, RemoteTarget>();

  async systems(): Promise<RemoteTestSystem[]> {
    const { targets } = await this.services.connections.listTargets();
    this.names.remember(targets);
    for (const t of targets) this.known.set(t.id, t);
    return targets.map((t) => ({ id: t.id, name: t.name, description: t.description, kind: t.kind }));
  }

  async run(
    systemId: string,
    request: RemoteTestRequest,
    events: RemoteTestRunEvents,
  ): Promise<RemoteTestRun> {
    if (!this.known.has(systemId)) await this.systems();
    const target = this.known.get(systemId);
    if (target === undefined) throw new Error('That remote system is no longer available.');
    const decoder = new TextDecoder();
    let result: TestRunResultRequest | undefined;
    let problem: string | undefined;
    const sink: TerminalSink = {
      frame: (frame) => {
        if (typeof frame === 'string') {
          const said = control(frame);
          result = said.result ?? result;
          problem = said.problem ?? problem;
          return;
        }
        if (frame[0] === 0x01) events.output(decoder.decode(frame.subarray(1), { stream: true }));
      },
      closed: () => {
        events.finished(
          result,
          problem ?? (result === undefined ? 'The run ended before it reported a result.' : undefined),
        );
      },
    };
    try {
      const started = await this.services.connections.runTests(target, request, sink);
      return {
        runId: started.runId,
        cancel: () => {
          started.stream.send(JSON.stringify({ t: 'signal', signal: 'SIGINT' }));
        },
      };
    } catch (error) {
      throw new Error(describeFailure(error), { cause: error });
    }
  }

  fileUri(systemId: string, path: string): string {
    return new URI(remoteRootUri(systemId)).resolve(path).toString();
  }
}
