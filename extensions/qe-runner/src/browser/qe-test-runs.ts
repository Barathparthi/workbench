import { ControlPlaneClient } from '@qe/client-sdk';
import type { TestSelector } from '@qe/runner';
import { QeEnvironmentService } from '@qe/theia-qe-core/lib/common/qe-environment';
import {
  RemoteConnectionProvider,
  type ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { MessageService } from '@theia/core/lib/common/message-service';
import type URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';

import {
  QE_RUNNER_PATH,
  type QeRunnerClient,
  type QeRunnerService,
  type RunOutcome,
} from '../common/qe-runner-protocol';
import { hostedRecorder, noRecorder, type RunRecorder } from './run-recorder';
import { describeSelector, TestRunsModel } from './test-runs-model';

const FRAMEWORK = 'pytest' as const;

/**
 * The panel's link to the test runner (PHASE_11 §11.6): the IDE backend runs tests in the project folder — the
 * workspace runtime, the local-web container or the user's machine — and this page only asks for runs as data and
 * shows what comes back (rule 1). In a hosted workspace each run is recorded on the control plane, first: the record's
 * id names the run's folder, so its result can only name files of that run.
 */
@injectable()
export class QeTestRuns {
  @inject(QeEnvironmentService) protected readonly environment!: QeEnvironmentService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(RemoteConnectionProvider) protected readonly connections!: ServiceConnectionProvider;

  readonly model = new TestRunsModel();
  protected backend: QeRunnerService | undefined;
  protected recorder: Promise<RunRecorder> | undefined;
  /** Hosted: the control plane record of each run in progress, by run id (they are the same id). */
  protected readonly recorded = new Set<string>();

  protected readonly client: QeRunnerClient = {
    onOutput: (runId, chunk) => {
      this.model.appendOutput(runId, chunk);
    },
    onFinished: (runId, outcome) => {
      this.model.finish(runId, outcome);
      void this.record(runId, outcome);
    },
  };

  @postConstruct()
  protected init(): void {
    // A page that comes back (reload) picks up runs still going.
    void this.service()
      .running()
      .then((runs) => {
        for (const { run, output } of runs) {
          this.model.addRun({
            runId: run.runId,
            where: 'project folder',
            selector: run.selector,
            startedAt: run.startedAt,
            output,
          });
        }
      })
      .catch(() => undefined);
  }

  protected service(): QeRunnerService {
    this.backend ??= this.connections.createProxy<QeRunnerService>(QE_RUNNER_PATH, this.client);
    return this.backend;
  }

  protected recorderFor(): Promise<RunRecorder> {
    this.recorder ??= this.environment.getEnvironment().then((env) =>
      env.mode === 'hosted' && env.workspaceId !== undefined
        ? hostedRecorder(
            // Same origin as the control plane in hosted mode; the client adds the CSRF token.
            new ControlPlaneClient({ baseUrl: '', readCookies: () => document.cookie }),
            env.workspaceId,
          )
        : noRecorder,
    );
    return this.recorder;
  }

  /** The project folder: the first workspace folder on this machine (remote folders are run with P11.5b). */
  projectRoot(): URI | undefined {
    return this.workspace.tryGetRoots().find((r) => r.resource.scheme === 'file')?.resource;
  }

  protected rootPath(): string | undefined {
    const root = this.projectRoot();
    return root === undefined ? undefined : FileUri.fsPath(root);
  }

  async refreshTests(): Promise<void> {
    const root = this.rootPath();
    if (root === undefined) {
      this.model.setTree([], 'Open a project folder to see its tests.');
      return;
    }
    this.model.setDiscovering();
    const result = await this.service()
      .discover(root, FRAMEWORK)
      .catch(() => undefined);
    if (result === undefined || !result.ok) {
      this.model.setTree([], 'The tests could not be listed: is pytest installed for this project?');
      return;
    }
    this.model.setTree(result.value.nodes, result.value.problem);
  }

  async loadHistory(): Promise<void> {
    const root = this.rootPath();
    if (root === undefined) return;
    const result = await this.service()
      .history(root, 20)
      .catch(() => undefined);
    if (result?.ok === true) this.model.setHistory(result.value);
  }

  /** Runs the selected tests in the project folder; the panel shows the run at once. */
  async run(selector: TestSelector): Promise<void> {
    const root = this.rootPath();
    if (root === undefined) {
      await this.messages.info('Open a project folder to run its tests.');
      return;
    }
    let recordId: string | undefined;
    try {
      recordId = await (await this.recorderFor()).start(FRAMEWORK, selector);
    } catch {
      await this.messages.error('The run could not be recorded for this workspace, so it was not started.');
      return;
    }
    const started = await this.service()
      .start(root, { framework: FRAMEWORK, selector, ...(recordId !== undefined && { runId: recordId }) })
      .catch(() => undefined);
    if (started === undefined || !started.ok) {
      const why =
        started?.code === 'QUOTA_EXCEEDED'
          ? 'Too many runs at once: wait for one to finish.'
          : (started?.message ?? 'The run could not be started.');
      if (recordId !== undefined) {
        // Recorded first: end the record so it does not stay RUNNING.
        void this.recordCancelled(recordId);
      }
      await this.messages.error(why);
      return;
    }
    if (recordId !== undefined) this.recorded.add(recordId);
    this.model.addRun({
      runId: started.value.runId,
      where: 'project folder',
      selector,
      startedAt: started.value.startedAt,
    });
  }

  async cancel(runId: string): Promise<void> {
    await this.service().cancel(runId);
  }

  label(selector: TestSelector): string {
    return describeSelector(selector);
  }

  protected async record(runId: string, outcome: RunOutcome): Promise<void> {
    void this.loadHistory();
    if (!this.recorded.delete(runId)) return;
    try {
      await (await this.recorderFor()).finish(runId, outcome);
    } catch {
      this.model.fail(runId, 'The result could not be recorded for this workspace.');
      this.model.finish(runId, outcome);
    }
  }

  protected async recordCancelled(recordId: string): Promise<void> {
    await (
      await this.recorderFor()
    )
      .finish(recordId, { state: 'ERROR', durationMs: 0, folder: '', log: '', artifacts: [] })
      .catch(() => undefined);
  }
}
