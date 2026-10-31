import type { TestRunResultRequest } from '@qe/contracts';
import type { RunState, TestCaseResult, TestNode, TestSelector } from '@qe/runner';
import { Emitter, type Event } from '@theia/core/lib/common/event';

import type { RunOutcome, RunRecord } from '../common/qe-runner-protocol';

/** Output kept per run in the panel; the run's log file has all of it. */
export const PANEL_OUTPUT_CHARS = 1024 * 1024;
/** Runs kept in the panel's list (this session's, newest first); older ones are in the history. */
const MAX_RUNS = 20;

export interface RunView {
  readonly runId: string;
  /** Where it ran: the project folder, or a remote system's name. */
  readonly where: string;
  /** A remote system's id when it ran there (its files open in the system's folder). */
  readonly systemId?: string;
  /** Stops a remote run (local runs are cancelled through the backend). */
  cancel?: () => void;
  readonly selector: TestSelector;
  readonly startedAt: string;
  state: RunState;
  output: string;
  outcome?: RunOutcome;
  /** Why it could not start or be recorded, for the user. */
  problem?: string;
}

/** A remote run's result (as the broker recorded it) in the panel's terms; no result: it never ran. */
export function outcomeOfRemote(
  runId: string,
  result: TestRunResultRequest | undefined,
  problem: string | undefined,
): RunOutcome {
  const folder = `.qe-runs/${runId}`;
  if (result === undefined) {
    return {
      state: 'ERROR',
      durationMs: 0,
      folder,
      log: '',
      artifacts: [],
      ...(problem !== undefined && { problem }),
    };
  }
  return {
    state: result.state,
    ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
    durationMs: result.durationMs,
    folder,
    log: '',
    artifacts: result.artifacts.flatMap((a) =>
      a.kind === 'junit_xml' || a.kind === 'html_report' || a.kind === 'log'
        ? [{ kind: a.kind, path: a.path, sizeBytes: a.sizeBytes, sha256: a.sha256 }]
        : [],
    ),
    results: {
      counts: result.counts,
      durationMs: result.durationMs,
      truncated: result.truncated,
      cases: result.failures.map((f) => ({
        id: f.id,
        name: f.name,
        status: f.status,
        durationMs: 0,
        ...(f.file !== undefined && { file: f.file }),
        ...(f.line !== undefined && { line: f.line }),
        ...(f.message !== undefined && { message: f.message }),
      })),
    },
    ...(problem !== undefined && { problem }),
  };
}

/** How a selector reads in the panel. */
export function describeSelector(selector: TestSelector): string {
  switch (selector.kind) {
    case 'all':
      return 'All tests';
    case 'file':
      return selector.path;
    case 'node':
      return selector.id;
    case 'marker':
      return `-m ${selector.expr}`;
  }
}

/** The failed and errored cases of a finished run, in report order. */
export function failuresOf(outcome: RunOutcome | undefined): TestCaseResult[] {
  return (outcome?.results?.cases ?? []).filter((c) => c.status === 'failed' || c.status === 'error');
}

/** "3 passed · 1 failed · 1 skipped", leaving out zeros; why there are no counts otherwise. */
export function summaryOf(outcome: RunOutcome | undefined): string {
  const counts = outcome?.results?.counts;
  if (counts === undefined) return outcome?.problem ?? '';
  const parts = [
    [counts.passed, 'passed'],
    [counts.failed, 'failed'],
    [counts.errors, counts.errors === 1 ? 'error' : 'errors'],
    [counts.skipped, 'skipped'],
  ] as const;
  const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `${String(n)} ${label}`);
  return shown.length === 0 ? 'no tests ran' : shown.join(' · ');
}

/**
 * What the QE Tests panel shows (PHASE_11 §11.6): the test tree, this session's runs with their live output and
 * results, and the history of earlier runs. No Theia widget code — the widget renders it, the services feed it.
 */
export class TestRunsModel {
  protected readonly changed = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changed.event;

  tree: TestNode[] = [];
  discovering = false;
  discoveryProblem: string | undefined;
  runs: RunView[] = [];
  history: RunRecord[] = [];
  /** The run whose output and results are on show. */
  selectedRunId: string | undefined;

  setTree(nodes: TestNode[], problem?: string): void {
    this.tree = nodes;
    this.discoveryProblem = problem;
    this.discovering = false;
    this.changed.fire();
  }

  /** Something the panel shows besides runs changed (the systems, where runs go). */
  touch(): void {
    this.changed.fire();
  }

  setDiscovering(): void {
    this.discovering = true;
    this.changed.fire();
  }

  setHistory(records: RunRecord[]): void {
    this.history = records;
    this.changed.fire();
  }

  /** A run that started (or, with `problem`, could not start); it is shown at once. */
  addRun(run: Omit<RunView, 'output' | 'state'> & { state?: RunState; output?: string }): RunView {
    const view: RunView = { output: '', state: 'RUNNING', ...run };
    this.runs = [view, ...this.runs.filter((r) => r.runId !== run.runId)].slice(0, MAX_RUNS);
    this.selectedRunId = view.runId;
    this.changed.fire();
    return view;
  }

  appendOutput(runId: string, chunk: string): void {
    const run = this.find(runId);
    if (run === undefined) return;
    const text = run.output + chunk;
    run.output = text.length > PANEL_OUTPUT_CHARS ? text.slice(text.length - PANEL_OUTPUT_CHARS) : text;
    this.changed.fire();
  }

  finish(runId: string, outcome: RunOutcome): void {
    const run = this.find(runId);
    if (run === undefined) return;
    run.state = outcome.state;
    run.outcome = outcome;
    this.changed.fire();
  }

  fail(runId: string, problem: string): void {
    const run = this.find(runId);
    if (run === undefined) return;
    run.state = 'ERROR';
    run.problem = problem;
    this.changed.fire();
  }

  select(runId: string): void {
    this.selectedRunId = runId;
    this.changed.fire();
  }

  get selected(): RunView | undefined {
    return this.selectedRunId === undefined ? undefined : this.find(this.selectedRunId);
  }

  get running(): RunView[] {
    return this.runs.filter((r) => r.state === 'RUNNING' || r.state === 'QUEUED');
  }

  /** A history record shown as a run of this session (its output is in its log file). */
  showRecord(record: RunRecord): void {
    this.addRun({
      runId: record.run.runId,
      where: 'project folder',
      selector: record.run.selector,
      startedAt: record.run.startedAt,
      state: record.outcome.state,
      outcome: record.outcome,
    });
  }

  protected find(runId: string): RunView | undefined {
    return this.runs.find((r) => r.runId === runId);
  }
}
