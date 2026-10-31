import { readFileSync } from 'node:fs';

import { mavenAdapter, pytestAdapter } from '@qe/runner';
import { FakeSftp } from '@qe/test-utils';
import { describe, expect, it } from 'vitest';

import { readRemoteRun, wrapSftp } from '../index.js';

const RUN = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const ROOT = '/home/qe/project';
// Tests run from the repository root.
const SUREFIRE = readFileSync('packages/runner/src/__tests__/fixtures/surefire-sample.xml', 'utf8');
const PYTEST = readFileSync('packages/runner/src/__tests__/fixtures/pytest-sample.xml', 'utf8');
const channel = (fake: FakeSftp) => wrapSftp(fake as unknown as Parameters<typeof wrapSftp>[0]);
const exit = (code: number | null, cancelled = false) => ({ code, cancelled, durationMs: 1500 });

describe('reading a remote run', () => {
  it('reads a Surefire run: the reports written since the run’s pid file, merged; counts and failures only', async () => {
    const fake = new FakeSftp({ home: '/home/qe' });
    fake.mkdirp(`${ROOT}/target/surefire-reports`);
    // An earlier build's report.
    fake.now = 1_761_000_000;
    fake.put(`${ROOT}/target/surefire-reports/TEST-com.example.OldTest.xml`, SUREFIRE);
    // The run: its pid file, then the reports it writes.
    fake.now = 1_761_000_100;
    fake.mkdirp(`${ROOT}/.qe-runs/${RUN}`).put(`${ROOT}/.qe-runs/${RUN}/pid`, '4242');
    fake.now = 1_761_000_130;
    fake.put(`${ROOT}/target/surefire-reports/TEST-com.example.ATest.xml`, SUREFIRE);
    fake.put(`${ROOT}/target/surefire-reports/TEST-com.example.BTest.xml`, SUREFIRE);
    fake.put(`${ROOT}/target/surefire-reports/com.example.ATest.txt`, 'summary');
    const { result, problem } = await readRemoteRun(
      channel(fake),
      ROOT,
      { runId: RUN, framework: 'maven', selector: { kind: 'all' } },
      exit(1),
      mavenAdapter,
    );
    expect(problem).toBeUndefined();
    expect(result).toMatchObject({
      state: 'FAILED',
      exitCode: 1,
      counts: { total: 8, passed: 2, failed: 2, errors: 2, skipped: 2 },
      artifacts: [],
    });
    expect(result.failures.map((f) => [f.status, f.file, f.line])).toEqual([
      ['failed', 'CalculatorTest.java', 21],
      ['error', 'CalculatorTest.java', 27],
      ['failed', 'CalculatorTest.java', 21],
      ['error', 'CalculatorTest.java', 27],
    ]);
  });

  it('records a failed exit without reports as an error, saying why', async () => {
    const fake = new FakeSftp({ home: '/home/qe' });
    fake.mkdirp(`${ROOT}/.qe-runs/${RUN}`).put(`${ROOT}/.qe-runs/${RUN}/pid`, '4242');
    const maven = await readRemoteRun(
      channel(fake),
      ROOT,
      { runId: RUN, framework: 'maven', selector: { kind: 'all' } },
      exit(1),
      mavenAdapter,
    );
    expect(maven).toMatchObject({
      result: { state: 'ERROR', counts: { total: 0 } },
      problem: 'the run wrote no test reports',
    });
    const pytest = await readRemoteRun(
      channel(fake),
      ROOT,
      { runId: RUN, framework: 'pytest', selector: { kind: 'all' } },
      exit(1),
      pytestAdapter,
    );
    expect(pytest).toMatchObject({ result: { state: 'ERROR' }, problem: 'the run wrote no JUnit report' });
    // Cancelled stays cancelled, report or not.
    const cancelled = await readRemoteRun(
      channel(fake),
      ROOT,
      { runId: RUN, framework: 'pytest', selector: { kind: 'all' } },
      exit(2, true),
      pytestAdapter,
    );
    expect(cancelled.result.state).toBe('CANCELLED');
  });

  it('reads a pytest run’s one report and keeps it as an artifact with its sha256', async () => {
    const fake = new FakeSftp({ home: '/home/qe' });
    fake.mkdirp(`${ROOT}/.qe-runs/${RUN}`).put(`${ROOT}/.qe-runs/${RUN}/junit.xml`, PYTEST);
    const { result } = await readRemoteRun(
      channel(fake),
      ROOT,
      { runId: RUN, framework: 'pytest', selector: { kind: 'all' } },
      exit(1),
      pytestAdapter,
    );
    expect(result).toMatchObject({
      state: 'FAILED',
      counts: { total: 5 },
      artifacts: [{ kind: 'junit_xml', sizeBytes: PYTEST.length }],
    });
  });
});
