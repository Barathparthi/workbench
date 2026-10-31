/**
 * The QE runner's model (PHASE_11 §11.1). A run is asked for as data — a framework and a selector — never as a
 * command line: the adapters build the argv, the same way for a run in the workspace runtime, on the user's machine
 * and on a remote target.
 */

/** The frameworks with an adapter. */
export const Frameworks = ['pytest', 'maven'] as const;
export type Framework = (typeof Frameworks)[number];

export const RunStates = ['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'CANCELLED'] as const;
export type RunState = (typeof RunStates)[number];

/** Which tests: all of them, one file, one test (a node id such as `tests/test_a.py::test_b`), or a marker expression. */
export type TestSelector =
  | { readonly kind: 'all' }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'marker'; readonly expr: string };

/** Where the run happens: the project folder of this IDE, or a registered remote target's folder. */
export type RunTarget = { readonly kind: 'local' } | { readonly kind: 'remote'; readonly targetId: string };

export interface TestRunRequest {
  readonly framework: Framework;
  readonly selector: TestSelector;
  readonly target: RunTarget;
  /** Extra environment for the test process; names and values are checked (`checkRunEnv`). */
  readonly env?: Readonly<Record<string, string>>;
}

/** A process to start: never through a shell (`spawn(file, args, { shell: false })`, or the broker's quoting helper). */
export interface RunCommand {
  readonly file: string;
  readonly args: readonly string[];
  /** Relative to the project folder; `.` is the folder itself. */
  readonly cwd: string;
}

/** Where a run writes its results: `.qe-runs/<runId>`, relative to the project folder. */
export interface RunContext {
  readonly runId: string;
  /** The Python interpreter to start (`python3`, or `python` on Windows). */
  readonly python: string;
  /** pytest-html is installed: also write a self-contained HTML report. */
  readonly htmlReport: boolean;
  /** The program for a framework that is not Python (Maven: the project's `./mvnw`, else `mvn`). */
  readonly tool?: string;
}

export interface RunFiles {
  /** `.qe-runs/<runId>`: the run's own folder. */
  readonly folder: string;
  /** The one JUnit report the run writes (pytest). */
  readonly junit?: string;
  /**
   * Or reports in a folder the framework owns (Surefire: `target/surefire-reports/TEST-*.xml`, one per test class).
   * The folder may hold reports of earlier builds: only those written during this run count.
   */
  readonly reports?: { readonly folder: string; readonly pattern: RegExp };
  readonly htmlReport?: string;
}

/** A node of the test tree shown before a run: a file, or a test in it. */
export interface TestNode {
  readonly id: string;
  readonly label: string;
  readonly kind: 'file' | 'test';
  /** The project-relative file the node belongs to. */
  readonly file: string;
  readonly children: readonly TestNode[];
}

export type CaseStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface TestCaseResult {
  readonly id: string;
  readonly name: string;
  readonly className?: string;
  readonly file?: string;
  readonly line?: number;
  readonly status: CaseStatus;
  readonly durationMs: number;
  /** Failure or skip message and stack, each capped (PHASE_11 §11.5). */
  readonly message?: string;
  readonly stack?: string;
}

export interface RunCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly skipped: number;
}

export interface RunResults {
  readonly counts: RunCounts;
  readonly durationMs: number;
  readonly cases: readonly TestCaseResult[];
  /** True when more cases or longer texts existed than are kept. */
  readonly truncated: boolean;
}

/** One framework (PHASE_11 §11.1): builds commands and reads their output; it never starts anything itself. */
export interface RunnerAdapter {
  readonly framework: Framework;
  /** The command that lists the tests of the project folder, for frameworks that have one. */
  discoverCommand?(context: Pick<RunContext, 'python'>): RunCommand;
  /**
   * For frameworks that cannot list tests without building (Maven): the files to list instead, under `folder`, whose
   * project-relative paths are given to `parseDiscovery`, one per line.
   */
  readonly discoverFiles?: { readonly folder: string; readonly pattern: RegExp };
  /** The test tree from the discovery command's standard output (or the listed files). */
  parseDiscovery(stdout: string): TestNode[];
  /** The command that runs the selected tests and writes JUnit XML (and a report) under `.qe-runs/<runId>`. */
  buildCommand(selector: TestSelector, context: RunContext): RunCommand;
  /** The state a finished run ends in, from its exit code (a cancelled run is CANCELLED whatever its code). */
  stateOf(exitCode: number): RunState;
  /**
   * Where the run writes its results, relative to the project folder: its folder, and there one JUnit report
   * (`junit`) or several (`reportPattern`: Surefire writes one per test class).
   */
  resultFiles(context: Pick<RunContext, 'runId'>): RunFiles;
}
