import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { pytestAdapter, type RunnerAdapter, type TestSelector } from '@qe/runner';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { QeRunnerClient, RunOutcome } from '../../common/qe-runner-protocol';
import {
  DEFAULT_RUNNER_OPTIONS,
  pythonFor,
  RunnerService,
  runEnvironment,
  runnerOptionsFrom,
  type RunnerServiceOptions,
} from '../runner-service';

const posix = process.platform !== 'win32';
const dir = mkdtempSync(join(tmpdir(), 'qe-runner-'));
const root = join(dir, 'project');
mkdirSync(root);

/** A stand-in for a test framework: what it does is chosen by MODE (passed as the run's extra environment). */
const SCRIPT = join(dir, 'framework.cjs');
writeFileSync(
  SCRIPT,
  `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const mode = process.env.MODE || 'pass';
if (process.argv[2] === 'discover') {
  console.log('tests/test_a.py::test_x');
  console.log('tests/test_a.py::test_y');
  if (mode === 'broken') { console.log('ERROR collecting tests/test_b.py'); process.exit(2); }
  process.exit(0);
}
console.log('selector ' + process.argv[3]);
console.log('env ' + JSON.stringify(Object.keys(process.env).filter((k) => /SECRET|PYTHON|^MODE$/.test(k)).sort()));
const hang = () => setInterval(() => {}, 1000);
switch (mode) {
  case 'pass': process.exit(0);
  case 'fail': process.exit(1);
  case 'hang': process.on('SIGINT', () => { console.log('interrupted'); process.exit(2); }); hang(); break;
  case 'stubborn': process.on('SIGINT', () => console.log('ignoring SIGINT')); hang(); break;
  case 'loud': process.stdout.write('x'.repeat(100000) + '\\n'); hang(); break;
  case 'junit':
    require('node:fs').copyFileSync(process.env.JUNIT_SRC, '.qe-runs/' + process.argv[2] + '/junit.xml');
    process.exit(1);
  case 'orphan': {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(process.env.PID_FILE, String(child.pid));
    setTimeout(() => process.exit(0), 200);
    break;
  }
}
`,
);

const adapter = (file = process.execPath): RunnerAdapter => ({
  ...pytestAdapter,
  discoverCommand: () => ({ file, args: [SCRIPT, 'discover'], cwd: '.' }),
  buildCommand: (selector: TestSelector, context) => ({
    file,
    args: [SCRIPT, context.runId, JSON.stringify(selector)],
    cwd: '.',
  }),
});

const fast: RunnerServiceOptions = { ...DEFAULT_RUNNER_OPTIONS, killGraceMs: 300, timeoutMs: 30_000 };

function setup(options: Partial<RunnerServiceOptions> = {}, file?: string) {
  const outputs = new Map<string, string>();
  const finished = new Map<string, RunOutcome>();
  const client: QeRunnerClient = {
    onOutput: (id, chunk) => outputs.set(id, (outputs.get(id) ?? '') + chunk),
    onFinished: (id, outcome) => finished.set(id, outcome),
  };
  const service = new RunnerService({
    options: { ...fast, ...options },
    adapterFor: () => adapter(file),
    env: { ...process.env, SECRET_TOKEN: 'canary-not-for-tests', PYTHONPATH: '/elsewhere' },
  });
  service.setClient(client);
  services.push(service);
  const done = async (runId: string) => {
    await vi.waitFor(
      () => {
        expect(finished.get(runId)).toBeDefined();
      },
      { timeout: 15_000 },
    );
    return finished.get(runId) as RunOutcome;
  };
  const start = async (
    mode: string,
    selector: TestSelector = { kind: 'all' },
    extra: Record<string, string> = {},
  ) => {
    const result = await service.start(root, {
      framework: 'pytest',
      selector,
      env: { MODE: mode, ...extra },
    });
    if (!result.ok) throw new Error(`not started: ${result.code}`);
    return result.value.runId;
  };
  return { service, client, outputs, finished, done, start };
}
const services: RunnerService[] = [];

afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('local test runs', () => {
  it('runs the adapter command without a shell, streams its output and logs all of it under .qe-runs/<runId>', async () => {
    const { start, done, outputs } = setup();
    const runId = await start('pass', { kind: 'file', path: './tests/test_a.py' });
    const outcome = await done(runId);
    expect(outcome).toMatchObject({
      state: 'PASSED',
      exitCode: 0,
      folder: `.qe-runs/${runId}`,
      log: `.qe-runs/${runId}/output.log`,
    });
    // The selector reached the process checked and normalized, as one argument.
    expect(outputs.get(runId)).toContain('selector {"kind":"file","path":"tests/test_a.py"}');
    await vi.waitFor(() => {
      expect(readFileSync(join(root, outcome.log), 'utf8')).toBe(outputs.get(runId));
    });
  });

  it('reads the report when the run ends, describes its files and keeps the record for the history', async () => {
    const { service, start, done } = setup();
    const runId = await start(
      'junit',
      { kind: 'all' },
      { JUNIT_SRC: resolve('packages/runner/src/__tests__/fixtures/pytest-sample.xml') },
    );
    const outcome = await done(runId);
    expect(outcome).toMatchObject({
      state: 'FAILED',
      results: { counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 }, truncated: false },
    });
    // Only the failures travel and are kept; the report has every case.
    expect(outcome.results?.cases).toEqual([
      expect.objectContaining({ file: 'tests/test_calculator.py', line: 21 }),
    ]);
    expect(outcome.artifacts.map((a) => a.kind)).toEqual(['junit_xml', 'log']);
    expect(outcome.artifacts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const history = await service.history(root, 5);
    expect(history.ok && history.value[0]).toMatchObject({
      run: { runId, state: 'FAILED' },
      outcome: { state: 'FAILED' },
    });
    expect(await service.history(join(dir, 'missing'), 5)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('says when a run wrote no report', async () => {
    const { start, done } = setup();
    const outcome = await done(await start('pass'));
    expect(outcome).toMatchObject({ problem: 'the run wrote no JUnit report' });
    expect(outcome.results).toBeUndefined();
    expect(outcome.artifacts.map((a) => a.kind)).toEqual(['log']);
  });

  it('maps the exit code through the adapter', async () => {
    const { start, done } = setup();
    expect(await done(await start('fail'))).toMatchObject({ state: 'FAILED', exitCode: 1 });
  });

  it('gives the test only allowlisted variables of the backend, the run’s own, and its fixed Python settings', async () => {
    const { start, done, outputs } = setup();
    const runId = await start('pass');
    await done(runId);
    expect(outputs.get(runId)).toContain('env ["MODE","PYTHONDONTWRITEBYTECODE","PYTHONUNBUFFERED"]');
    expect(
      runEnvironment({ PATH: '/bin', SECRET_TOKEN: 'x', QE_LOCAL_WEB_TOKEN: 'y', Path: 'C:\\' }, { A: '1' }),
    ).toEqual({
      PATH: '/bin',
      Path: 'C:\\',
      A: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
    });
  });

  it('refuses a bad request before starting anything', async () => {
    const { service } = setup();
    const start = (request: object, at = root) =>
      service.start(at, { framework: 'pytest', selector: { kind: 'all' }, ...request } as never);
    expect(await start({ selector: { kind: 'file', path: '../outside.py' } })).toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'selector.path: leaves the project folder',
    });
    expect(await start({ selector: { kind: 'node', id: 'tests/a.py::t; id' } })).toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(await start({ env: { LD_PRELOAD: '/tmp/x.so' } })).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await start({ framework: 'make' })).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await start({}, 'relative/path')).toMatchObject({ code: 'NOT_FOUND' });
    expect(await start({}, join(dir, 'missing'))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await service.running()).toEqual([]);
  });

  it('allows a limited number of runs at a time, across every page', async () => {
    const { service, start, done } = setup({ maxConcurrent: 1 });
    const first = await start('hang');
    expect(await service.start(root, { framework: 'pytest', selector: { kind: 'all' } })).toMatchObject({
      ok: false,
      code: 'QUOTA_EXCEEDED',
    });
    await service.cancel(first);
    expect(await done(first)).toMatchObject({ state: 'CANCELLED' });
    await done(await start('pass'));
  });

  it('cancels with SIGINT first, so the framework can stop cleanly', async () => {
    const { service, start, done, outputs } = setup();
    const runId = await start('hang');
    await vi.waitFor(() => {
      expect(outputs.get(runId)).toContain('env');
    });
    await service.cancel(runId);
    expect(await done(runId)).toMatchObject({ state: 'CANCELLED' });
    if (posix) expect(outputs.get(runId)).toContain('interrupted');
  });

  it('kills a run that ignores SIGINT after the grace time', async () => {
    const { service, start, done, outputs } = setup({ killGraceMs: 300 });
    const runId = await start('stubborn');
    await vi.waitFor(() => {
      expect(outputs.get(runId)).toContain('env');
    });
    const started = Date.now();
    await service.cancel(runId);
    expect(await done(runId)).toMatchObject({ state: 'CANCELLED' });
    if (posix) {
      expect(outputs.get(runId)).toContain('ignoring SIGINT');
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    }
  });

  it('cancels a run that takes longer than the time limit, and says so', async () => {
    const { start, done, outputs } = setup({ timeoutMs: 500 });
    const runId = await start('hang');
    expect(await done(runId)).toMatchObject({ state: 'CANCELLED' });
    expect(outputs.get(runId)).toContain('[QE: the run took longer than');
  });

  it('keeps the latest output in memory for pages that come later, and all of it in the log', async () => {
    const { service, start, done, outputs } = setup({ outputChars: 1000 });
    const runId = await start('loud');
    await vi.waitFor(() => {
      expect(outputs.get(runId)?.length ?? 0).toBeGreaterThan(100_000);
    });
    const [running] = await service.running();
    expect(running?.run).toMatchObject({ runId, state: 'RUNNING', framework: 'pytest' });
    // Whole chunks are dropped, oldest first; the newest chunk is always kept.
    expect(running?.output.length).toBeLessThan(outputs.get(runId)?.length ?? 0);
    expect(running?.output.endsWith('x\n')).toBe(true);
    await service.cancel(runId);
    const outcome = await done(runId);
    await vi.waitFor(() => {
      expect(readFileSync(join(root, outcome.log), 'utf8').length).toBeGreaterThan(100_000);
    });
  });

  it.runIf(posix)('ends what a test started and left running when the run ends', async () => {
    const { start, done } = setup();
    const pidFile = join(dir, 'orphan.pid');
    const runId = await start('orphan', { kind: 'all' }, { PID_FILE: pidFile });
    expect(await done(runId)).toMatchObject({ state: 'PASSED' });
    const orphan = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => {
      expect(() => process.kill(orphan, 0)).toThrow();
    });
  });

  it('reports a framework that cannot be started as an error of the run', async () => {
    const { service, start, done, outputs } = setup({}, join(dir, 'no-such-interpreter'));
    const runId = await start('pass');
    expect(await done(runId)).toMatchObject({ state: 'ERROR' });
    expect(outputs.get(runId)).toContain('could not be started');
    expect(await service.running()).toEqual([]);
  });

  it('tells every connected page, and no page after it left', async () => {
    const { service, start, done } = setup();
    const other = { onOutput: vi.fn(), onFinished: vi.fn() };
    const gone = { onOutput: vi.fn(), onFinished: vi.fn() };
    service.setClient(other);
    service.setClient(gone);
    service.removeClient(gone);
    const runId = await start('pass');
    await done(runId);
    expect(other.onFinished).toHaveBeenCalledWith(runId, expect.objectContaining({ state: 'PASSED' }));
    expect(gone.onOutput).not.toHaveBeenCalled();
    expect(gone.onFinished).not.toHaveBeenCalled();
  });
});

describe('test discovery', () => {
  it('lists the tests the framework collects', async () => {
    const { service } = setup();
    const result = await service.discover(root, 'pytest');
    expect(result).toMatchObject({ ok: true, value: { nodes: [{ id: 'tests/test_a.py', kind: 'file' }] } });
    expect(result.ok && result.value.problem).toBeFalsy();
  });

  it('says what went wrong when the framework could not collect every test', async () => {
    const service = new RunnerService({
      options: fast,
      adapterFor: () => adapter(),
      env: { ...process.env, MODE: 'broken' },
    });
    // MODE is not an inherited variable: the backend's environment does not reach the framework.
    const result = await service.discover(root, 'pytest');
    expect(result.ok && result.value.problem).toBeFalsy();
    const broken = new RunnerService({
      options: fast,
      adapterFor: () => ({
        ...adapter(),
        discoverCommand: () => ({
          file: process.execPath,
          args: ['-e', 'console.log("tests/a.py::t"); console.error("ERROR collecting"); process.exit(2)'],
          cwd: '.',
        }),
      }),
    });
    expect(await broken.discover(root, 'pytest')).toMatchObject({
      ok: true,
      value: {
        nodes: [{ id: 'tests/a.py' }],
        problem: expect.stringContaining('ERROR collecting') as string,
      },
    });
  });

  it('refuses unknown frameworks and folders, and reports a missing interpreter', async () => {
    const { service } = setup();
    expect(await service.discover(root, 'make' as never)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await service.discover(join(dir, 'missing'), 'pytest')).toMatchObject({ code: 'NOT_FOUND' });
    const missing = new RunnerService({ options: fast, adapterFor: () => adapter(join(dir, 'nope')) });
    expect(await missing.discover(root, 'pytest')).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
  });
});

describe('runner settings', () => {
  it('prefers the project’s virtual environment', async () => {
    const project = join(dir, 'venv-project');
    mkdirSync(join(project, '.venv', 'bin'), { recursive: true });
    mkdirSync(join(project, '.venv', 'Scripts'), { recursive: true });
    writeFileSync(join(project, '.venv', 'bin', 'python'), '');
    writeFileSync(join(project, '.venv', 'Scripts', 'python.exe'), '');
    expect(await pythonFor(project, 'linux')).toBe(join(project, '.venv', 'bin', 'python'));
    expect(await pythonFor(project, 'win32')).toBe(join(project, '.venv', 'Scripts', 'python.exe'));
    expect(await pythonFor(root, 'linux')).toBe('python3');
    expect(await pythonFor(root, 'win32')).toBe('python');
    expect(existsSync(join(root, '.venv'))).toBe(false);
  });

  it('takes limits from the runtime environment, keeping the defaults for invalid values', () => {
    expect(runnerOptionsFrom({})).toEqual(DEFAULT_RUNNER_OPTIONS);
    expect(runnerOptionsFrom({ QE_RUNNER_MAX_CONCURRENT: '4', QE_RUNNER_TIMEOUT_MIN: '5' })).toMatchObject({
      maxConcurrent: 4,
      timeoutMs: 5 * 60_000,
    });
    for (const bad of ['0', '17', '1.5', 'x'])
      expect(runnerOptionsFrom({ QE_RUNNER_MAX_CONCURRENT: bad }).maxConcurrent).toBe(2);
    expect(runnerOptionsFrom({ QE_RUNNER_TIMEOUT_MIN: '0' }).timeoutMs).toBe(
      DEFAULT_RUNNER_OPTIONS.timeoutMs,
    );
  });
});
