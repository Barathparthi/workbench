import type { Framework, RunResults, RunState, TestNode, TestSelector } from '@qe/runner';
import type { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

/**
 * Test runs in the project folder (PHASE_11 §11.3): in the workspace runtime (hosted), the local-web container or on
 * the user's machine (desktop), run by the IDE backend — the browser page never starts a process (rule 1). The page
 * asks for a run as data; the backend builds the command with the framework's adapter and starts it without a shell.
 */
export const QE_RUNNER_PATH = '/services/qe-runner';
export const QeRunnerService = Symbol('QeRunnerService');

/** Results cross the RPC channel as data, so the error code arrives intact. */
export type RunnerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message?: string };

export interface StartRunRequest {
  readonly framework: Framework;
  readonly selector: TestSelector;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The run's id, when the caller recorded it first (hosted: the control plane's record, whose artifacts must be in
   * `.qe-runs/<id>/`). A lowercase UUID whose folder does not exist yet; otherwise the backend picks one.
   */
  readonly runId?: string;
}

export interface RunInfo {
  readonly runId: string;
  readonly framework: Framework;
  readonly selector: TestSelector;
  readonly state: RunState;
  readonly startedAt: string;
}

/** A file the run wrote, for the run's record (PHASE_11 §11.5): size and sha256, path relative to the project. */
export interface RunArtifact {
  readonly kind: 'junit_xml' | 'html_report' | 'log';
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface RunOutcome {
  readonly state: RunState;
  /** Undefined when the process could not start or was ended by a signal. */
  readonly exitCode?: number;
  readonly durationMs: number;
  /** The run's folder and full output log, relative to the project folder. */
  readonly folder: string;
  readonly log: string;
  /** From the JUnit report; absent when the run wrote none (it could not start, or was cancelled early). */
  readonly results?: RunResults;
  /** Why the report could not be read (malformed, too large). */
  readonly problem?: string;
  readonly artifacts: readonly RunArtifact[];
}

/** A finished run as saved in its folder (`.qe-runs/<runId>/run.json`): the history of the local modes. */
export interface RunRecord {
  readonly run: RunInfo;
  readonly outcome: RunOutcome;
}

export interface Discovery {
  readonly nodes: TestNode[];
  /** The end of the framework's output when it could not collect every test (an import error, a syntax error). */
  readonly problem?: string;
}

export interface QeRunnerService extends RpcServer<QeRunnerClient> {
  /** The project's framework: Maven where it has a pom.xml, else pytest. */
  framework(root: string): Promise<RunnerResult<Framework>>;
  /** The tests of the project folder at `root` (an absolute path of a workspace folder). */
  discover(root: string, framework: Framework): Promise<RunnerResult<Discovery>>;
  /** Starts a run; its output and its end arrive through the client. `QUOTA_EXCEEDED` when too many are running. */
  start(root: string, request: StartRunRequest): Promise<RunnerResult<RunInfo>>;
  cancel(runId: string): Promise<void>;
  /** The latest finished runs of the project folder at `root`, newest first, from their `run.json`. */
  history(root: string, limit: number): Promise<RunnerResult<RunRecord[]>>;
  /** Runs still going, and the output each has kept so far (a reloaded page picks them up again). */
  running(): Promise<{ run: RunInfo; output: string }[]>;
}

/** What the backend calls on every connected page. */
export interface QeRunnerClient {
  onOutput(runId: string, chunk: string): void;
  onFinished(runId: string, outcome: RunOutcome): void;
}
