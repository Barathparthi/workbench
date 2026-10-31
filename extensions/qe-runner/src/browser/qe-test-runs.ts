import { ControlPlaneClient } from '@qe/client-sdk';
import type { Framework, TestSelector } from '@qe/runner';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { QeEnvironmentService } from '@qe/theia-qe-core/lib/common/qe-environment';
import { QeRemoteTestRunner, type RemoteTestSystem } from '@qe/theia-qe-core/lib/common/qe-remote-tests';
import {
  RemoteConnectionProvider,
  type ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { MessageService } from '@theia/core/lib/common/message-service';
import type URI from '@theia/core/lib/common/uri';
import { inject, injectable, optional, postConstruct } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';

import {
  QE_RUNNER_PATH,
  type QeRunnerClient,
  type QeRunnerService,
  type RunOutcome,
} from '../common/qe-runner-protocol';
import { hostedRecorder, noRecorder, type RunRecorder } from './run-recorder';
import { describeSelector, outcomeOfRemote, TestRunsModel } from './test-runs-model';

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
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;

  /** The project's framework: `qe.runner.framework`, or detected (a pom.xml is Maven) when it is `auto`. */
  framework: Framework = 'pytest';
  @inject(RemoteConnectionProvider) protected readonly connections!: ServiceConnectionProvider;
  /** Bound by qe-remote where remote systems exist: the panel then offers "Run on". */
  @inject(QeRemoteTestRunner) @optional() protected readonly remote: QeRemoteTestRunner | undefined;

  /** Where runs go: undefined for the project folder, else a remote system's id. */
  runOn: string | undefined;
  systems: RemoteTestSystem[] = [];

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

  /** Decides the framework for the project folder at `root`: the setting, or what the project looks like. */
  protected async detectFramework(root: string): Promise<Framework> {
    const chosen = this.preferences.get<string>('qe.runner.framework', 'auto');
    if (chosen === 'pytest' || chosen === 'maven') return chosen;
    const detected = await this.service()
      .framework(root)
      .catch(() => undefined);
    return detected?.ok === true ? detected.value : 'pytest';
  }

  async refreshTests(): Promise<void> {
    const root = this.rootPath();
    if (root === undefined) {
      this.model.setTree([], 'Open a project folder to see its tests.');
      return;
    }
    this.model.setDiscovering();
    this.framework = await this.detectFramework(root);
    const result = await this.service()
      .discover(root, this.framework)
      .catch(() => undefined);
    if (result === undefined || !result.ok) {
      this.model.setTree(
        [],
        this.framework === 'maven'
          ? 'The test classes could not be listed.'
          : 'The tests could not be listed: is pytest installed for this project?',
      );
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
      recordId = await (await this.recorderFor()).start(this.framework, selector);
    } catch {
      await this.messages.error('The run could not be recorded for this workspace, so it was not started.');
      return;
    }
    const started = await this.service()
      .start(root, {
        framework: this.framework,
        selector,
        ...(recordId !== undefined && { runId: recordId }),
      })
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
    const run = this.model.runs.find((r) => r.runId === runId);
    if (run?.cancel !== undefined) {
      run.cancel();
      return;
    }
    await this.service().cancel(runId);
  }

  /** The remote systems the panel can run on (none without qe-remote, or when they cannot be listed). */
  async loadSystems(): Promise<void> {
    if (this.remote === undefined) return;
    this.systems = await this.remote.systems().catch(() => []);
    this.model.touch();
  }

  setRunOn(systemId: string | undefined): void {
    this.runOn = systemId;
    this.model.touch();
  }

  /** Runs where the panel says: the project folder, or the chosen remote system's folder. */
  async runSelected(selector: TestSelector): Promise<void> {
    const system = this.systems.find((s) => s.id === this.runOn);
    if (system === undefined || this.remote === undefined) {
      await this.run(selector);
      return;
    }
    // Output, or even the end, may arrive before run() returns the id: held until the run is in the panel.
    let runId: string | undefined;
    const early: string[] = [];
    let ended: Parameters<Parameters<QeRemoteTestRunner['run']>[2]['finished']> | undefined;
    try {
      const run = await this.remote.run(
        system.id,
        { framework: this.framework, selector },
        {
          output: (text) => {
            if (runId === undefined) early.push(text);
            else this.model.appendOutput(runId, text);
          },
          finished: (result, problem) => {
            if (runId === undefined) ended = [result, problem];
            else this.model.finish(runId, outcomeOfRemote(runId, result, problem));
          },
        },
      );
      runId = run.runId;
      this.model.addRun({
        runId,
        where: system.name,
        systemId: system.id,
        selector,
        startedAt: new Date().toISOString(),
        cancel: () => {
          run.cancel();
        },
      });
      for (const text of early.splice(0)) this.model.appendOutput(runId, text);
      if (ended !== undefined) this.model.finish(runId, outcomeOfRemote(runId, ...ended));
    } catch (error) {
      await this.messages.error(error instanceof Error ? error.message : 'The run could not be started.');
    }
  }

  /** A file of where a run happened, to open: the project folder's, or the remote system's folder's. */
  remoteFileUri(systemId: string, path: string): string | undefined {
    return this.remote?.fileUri(systemId, path);
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
