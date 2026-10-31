import { describe, expect, it, vi } from 'vitest';

import type { RunOutcome } from '../../common/qe-runner-protocol';
import { hostedRecorder, noRecorder, resultOf } from '../run-recorder';
import {
  describeSelector,
  failuresOf,
  outcomeOfRemote,
  sourcePathOf,
  PANEL_OUTPUT_CHARS,
  summaryOf,
  TestRunsModel,
} from '../test-runs-model';

const RUN = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  state: 'FAILED',
  exitCode: 1,
  durationMs: 1234.6,
  folder: `.qe-runs/${RUN}`,
  log: `.qe-runs/${RUN}/output.log`,
  artifacts: [
    { kind: 'junit_xml', path: `.qe-runs/${RUN}/junit.xml`, sizeBytes: 10, sha256: 'a'.repeat(64) },
  ],
  results: {
    counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 },
    durationMs: 30,
    truncated: false,
    cases: [
      {
        id: 'tests.test_calc::test_bad',
        name: 'test_bad',
        status: 'failed',
        durationMs: 1,
        file: 'tests/test_calc.py',
        line: 21,
        message: 'assert -5 == -6',
      },
    ],
  },
  ...over,
});

describe('the QE Tests panel’s model', () => {
  it('shows a started run at once, streams its output and keeps the latest 1 MB of it', () => {
    const model = new TestRunsModel();
    const changed = vi.fn();
    model.onDidChange(changed);
    model.addRun({
      runId: RUN,
      where: 'project folder',
      selector: { kind: 'all' },
      startedAt: '2026-10-31T10:00:00Z',
    });
    expect(model.selected).toMatchObject({ runId: RUN, state: 'RUNNING', output: '' });
    expect(model.running).toHaveLength(1);
    model.appendOutput(RUN, 'collected 5 items\n');
    model.appendOutput(RUN, 'x'.repeat(PANEL_OUTPUT_CHARS));
    expect(model.selected?.output).toHaveLength(PANEL_OUTPUT_CHARS);
    expect(model.selected?.output.startsWith('x')).toBe(true);
    model.finish(RUN, outcome());
    expect(model.selected).toMatchObject({ state: 'FAILED' });
    expect(model.running).toHaveLength(0);
    model.appendOutput('another', 'ignored');
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('keeps 20 runs, newest first, and shows a history record as a run', () => {
    const model = new TestRunsModel();
    for (let i = 0; i < 25; i++)
      model.addRun({ runId: `r${String(i)}`, where: 'x', selector: { kind: 'all' }, startedAt: '' });
    expect(model.runs).toHaveLength(20);
    expect(model.runs[0]?.runId).toBe('r24');
    model.showRecord({
      run: {
        runId: RUN,
        framework: 'pytest',
        selector: { kind: 'file', path: 'a.py' },
        state: 'PASSED',
        startedAt: 't',
      },
      outcome: outcome({ state: 'PASSED' }),
    });
    expect(model.selected).toMatchObject({ runId: RUN, state: 'PASSED' });
    model.fail(RUN, 'not recorded');
    expect(model.selected).toMatchObject({ state: 'ERROR', problem: 'not recorded' });
  });

  it('describes selectors, summaries and failures as the panel shows them', () => {
    expect(describeSelector({ kind: 'all' })).toBe('All tests');
    expect(describeSelector({ kind: 'file', path: 'tests/a.py' })).toBe('tests/a.py');
    expect(describeSelector({ kind: 'node', id: 'tests/a.py::t' })).toBe('tests/a.py::t');
    expect(describeSelector({ kind: 'marker', expr: 'slow' })).toBe('-m slow');
    expect(summaryOf(outcome())).toBe('3 passed · 1 failed · 1 skipped');
    expect(
      summaryOf(
        outcome({
          results: {
            counts: { total: 2, passed: 0, failed: 0, errors: 2, skipped: 0 },
            durationMs: 0,
            truncated: false,
            cases: [],
          },
        }),
      ),
    ).toBe('2 errors');
    const withProblem = outcome({ problem: 'the run wrote no JUnit report' });
    expect(
      summaryOf({
        state: withProblem.state,
        durationMs: 0,
        folder: '',
        log: '',
        artifacts: [],
        problem: 'the run wrote no JUnit report',
      }),
    ).toBe('the run wrote no JUnit report');
    expect(withProblem.results).toBeDefined();
    expect(failuresOf(outcome()).map((c) => c.line)).toEqual([21]);
    expect(failuresOf(undefined)).toEqual([]);
  });
});

describe('recording runs (hosted)', () => {
  it('turns an outcome into the control plane’s result: capped failures, the run’s files', () => {
    expect(resultOf(outcome())).toEqual({
      state: 'FAILED',
      exitCode: 1,
      durationMs: 1235,
      counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 },
      failures: [
        {
          id: 'tests.test_calc::test_bad',
          name: 'test_bad',
          status: 'failed',
          file: 'tests/test_calc.py',
          line: 21,
          message: 'assert -5 == -6',
        },
      ],
      truncated: false,
      artifacts: [
        { kind: 'junit_xml', path: `.qe-runs/${RUN}/junit.xml`, sizeBytes: 10, sha256: 'a'.repeat(64) },
      ],
    });
    // A run that never reported (still RUNNING) is recorded as an error, never as RUNNING.
    expect(resultOf(outcome({ state: 'RUNNING' })).state).toBe('ERROR');
  });

  it('records on the workspace first, then the result under the same id; elsewhere, nothing', async () => {
    const request = vi.fn((method: string, path: string) =>
      Promise.resolve(method === 'POST' && path.endsWith('/test-runs') ? { id: RUN } : {}),
    );
    const recorder = hostedRecorder({ request }, '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70');
    expect(await recorder.start('pytest', { kind: 'all' })).toBe(RUN);
    await recorder.finish(RUN, outcome());
    expect(request.mock.calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      'POST /api/v1/workspaces/0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70/test-runs',
      `POST /api/v1/test-runs/${RUN}/result`,
    ]);
    expect(await noRecorder.start('pytest', { kind: 'all' })).toBeUndefined();
  });
});

describe('remote runs in the panel', () => {
  it('shows a remote result as an outcome, and a run that never ran as an error with its reason', () => {
    const remote = outcomeOfRemote(
      RUN,
      {
        state: 'FAILED',
        exitCode: 1,
        durationMs: 900,
        counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 },
        failures: [
          { id: 'a::t', name: 't', status: 'failed', file: 'tests/a.py', line: 21, message: 'boom' },
        ],
        truncated: false,
        artifacts: [
          { kind: 'junit_xml', path: `.qe-runs/${RUN}/junit.xml`, sizeBytes: 9, sha256: 'b'.repeat(64) },
          { kind: 'screenshot', path: `.qe-runs/${RUN}/s.png`, sizeBytes: 1, sha256: 'c'.repeat(64) },
        ],
      },
      undefined,
    );
    expect(summaryOf(remote)).toBe('3 passed · 1 failed · 1 skipped');
    expect(failuresOf(remote)).toEqual([
      {
        id: 'a::t',
        name: 't',
        status: 'failed',
        durationMs: 0,
        file: 'tests/a.py',
        line: 21,
        message: 'boom',
      },
    ]);
    expect(remote.artifacts.map((a) => a.kind)).toEqual(['junit_xml']);
    expect(outcomeOfRemote(RUN, undefined, 'You are not allowed to connect to this system.')).toMatchObject({
      state: 'ERROR',
      problem: 'You are not allowed to connect to this system.',
    });
  });
});

describe('opening a failure', () => {
  it('opens pytest’s file as named, and a Java test by its class under src/test/java', () => {
    const base = { id: 'x', name: 'x', status: 'failed' as const, durationMs: 0 };
    expect(sourcePathOf({ ...base, file: 'tests/test_a.py', line: 3 })).toBe('tests/test_a.py');
    expect(
      sourcePathOf({ ...base, file: 'CalculatorTest.java', className: 'com.example.CalculatorTest' }),
    ).toBe('src/test/java/com/example/CalculatorTest.java');
    expect(
      sourcePathOf({ ...base, file: 'CalculatorTest.java', className: 'com.example.CalculatorTest$Nested' }),
    ).toBe('src/test/java/com/example/CalculatorTest.java');
    expect(sourcePathOf({ ...base, file: 'CalculatorTest.java' })).toBe('CalculatorTest.java');
    expect(sourcePathOf(base)).toBeUndefined();
  });
});
