import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { RunOutcome, RunRecord } from '../../common/qe-runner-protocol';
import {
  describeFile,
  MAX_RECORDED_FAILURES,
  readHistory,
  readReport,
  recordedOutcome,
  runArtifacts,
  saveRecord,
} from '../run-results';

const dir = mkdtempSync(join(tmpdir(), 'qe-run-results-'));
// Tests run from the repository root.
const PYTEST_REPORT = readFileSync('packages/runner/src/__tests__/fixtures/pytest-sample.xml', 'utf8');
const id = (n: number) => `0192d2a4-7c1e-7d3a-9f4b-${String(n).padStart(12, '0')}`;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a run’s results', () => {
  it('describes files by size and sha256, and nothing that is not there', async () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello');
    expect(await describeFile(file)).toEqual({
      sizeBytes: 5,
      sha256: createHash('sha256').update('hello').digest('hex'),
    });
    expect(await describeFile(join(dir, 'missing'))).toBeUndefined();
    expect(await describeFile(dir)).toBeUndefined();
  });

  it('reads the report, or says why not', async () => {
    const report = join(dir, 'junit.xml');
    writeFileSync(report, PYTEST_REPORT);
    expect((await readReport(report)).results?.counts).toEqual({
      total: 5,
      passed: 3,
      failed: 1,
      errors: 0,
      skipped: 1,
    });
    expect(await readReport(join(dir, 'none.xml'))).toEqual({ problem: 'the run wrote no JUnit report' });
    writeFileSync(report, '<testsuite><testcase>');
    expect(await readReport(report)).toEqual({ problem: 'the JUnit report is not well-formed XML' });
  });

  it('lists the files the run wrote, in a fixed order', async () => {
    const root = join(dir, 'p');
    mkdirSync(join(root, '.qe-runs', id(1)), { recursive: true });
    writeFileSync(join(root, '.qe-runs', id(1), 'output.log'), 'log');
    writeFileSync(join(root, '.qe-runs', id(1), 'junit.xml'), PYTEST_REPORT);
    const artifacts = await runArtifacts(root, {
      junit: `.qe-runs/${id(1)}/junit.xml`,
      htmlReport: `.qe-runs/${id(1)}/report.html`,
      log: `.qe-runs/${id(1)}/output.log`,
    });
    expect(artifacts.map((a) => [a.kind, a.path, a.sizeBytes])).toEqual([
      ['junit_xml', `.qe-runs/${id(1)}/junit.xml`, PYTEST_REPORT.length],
      ['log', `.qe-runs/${id(1)}/output.log`, 3],
    ]);
  });

  it('records every count but only failures, at most 200', () => {
    const cases = Array.from({ length: 450 }, (_, i) => ({
      id: `t${String(i)}`,
      name: `t${String(i)}`,
      status: i % 2 === 0 ? ('failed' as const) : ('passed' as const),
      durationMs: 1,
    }));
    const outcome: RunOutcome = {
      state: 'FAILED',
      durationMs: 1,
      folder: '.qe-runs/x',
      log: '.qe-runs/x/output.log',
      artifacts: [],
      results: {
        counts: { total: 450, passed: 225, failed: 225, errors: 0, skipped: 0 },
        durationMs: 450,
        cases,
        truncated: false,
      },
    };
    const recorded = recordedOutcome(outcome);
    expect(recorded.results?.counts.total).toBe(450);
    expect(recorded.results?.cases).toHaveLength(MAX_RECORDED_FAILURES);
    expect(recorded.results?.cases.every((c) => c.status === 'failed')).toBe(true);
    expect(recorded.results?.truncated).toBe(true);
    const withoutResults: RunOutcome = {
      state: outcome.state,
      durationMs: outcome.durationMs,
      folder: outcome.folder,
      log: outcome.log,
      artifacts: outcome.artifacts,
    };
    expect(recordedOutcome(withoutResults)).toEqual(withoutResults);
  });

  it('reads the history back newest first, skipping folders that are not runs', async () => {
    const root = join(dir, 'history');
    const record = (n: number, startedAt: string): RunRecord => ({
      run: { runId: id(n), framework: 'pytest', selector: { kind: 'all' }, state: 'PASSED', startedAt },
      outcome: {
        state: 'PASSED',
        durationMs: 1,
        folder: `.qe-runs/${id(n)}`,
        log: `.qe-runs/${id(n)}/output.log`,
        artifacts: [],
      },
    });
    for (const [n, at] of [
      [1, '2026-10-30T10:00:00.000Z'],
      [2, '2026-10-30T12:00:00.000Z'],
      [3, '2026-10-30T11:00:00.000Z'],
    ] as const) {
      mkdirSync(join(root, '.qe-runs', id(n)), { recursive: true });
      await saveRecord(root, record(n, at));
    }
    // Not runs: a folder that is not a run id, a half-written record, another run's record copied here, a big file.
    mkdirSync(join(root, '.qe-runs', 'notes'), { recursive: true });
    writeFileSync(
      join(root, '.qe-runs', 'notes', 'run.json'),
      JSON.stringify(record(4, '2026-10-30T13:00:00.000Z')),
    );
    mkdirSync(join(root, '.qe-runs', id(5)), { recursive: true });
    writeFileSync(join(root, '.qe-runs', id(5), 'run.json'), '{"run":');
    mkdirSync(join(root, '.qe-runs', id(6)), { recursive: true });
    writeFileSync(
      join(root, '.qe-runs', id(6), 'run.json'),
      JSON.stringify(record(1, '2026-10-30T14:00:00.000Z')),
    );
    mkdirSync(join(root, '.qe-runs', id(7)), { recursive: true });
    writeFileSync(join(root, '.qe-runs', id(7), 'run.json'), 'x'.repeat(1024 * 1024 + 1));
    writeFileSync(join(root, '.qe-runs', 'stray.txt'), '');

    expect((await readHistory(root, 10)).map((r) => r.run.runId)).toEqual([id(2), id(3), id(1)]);
    expect((await readHistory(root, 1)).map((r) => r.run.runId)).toEqual([id(2)]);
    expect(await readHistory(join(dir, 'no-runs'), 10)).toEqual([]);
  });
});
