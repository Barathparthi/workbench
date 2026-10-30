/**
 * The runner against real pytest (PHASE_11 §Tests "Integration"): the sample project (3 pass, 1 fail, 1 skip) run in
 * a copy, as the IDE backend does it. Needs `python3 -m pytest` (CI installs the distribution's python3-pytest);
 * skipped without it.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { QeRunnerClient, RunOutcome } from '../../common/qe-runner-protocol';
import { DEFAULT_RUNNER_OPTIONS, RunnerService } from '../runner-service';

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPytest = spawnSync(python, ['-m', 'pytest', '--version'], { shell: false }).status === 0;
// Tests run from the repository root.
const SAMPLE = resolve('tests/fixtures/sample-pytest-repo');
const dir = mkdtempSync(join(tmpdir(), 'qe-runner-int-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function project(name: string): string {
  const root = join(dir, name);
  cpSync(SAMPLE, root, { recursive: true });
  return root;
}

function runner() {
  const outputs = new Map<string, string>();
  const finished = new Map<string, RunOutcome>();
  const client: QeRunnerClient = {
    onOutput: (id, chunk) => outputs.set(id, (outputs.get(id) ?? '') + chunk),
    onFinished: (id, outcome) => finished.set(id, outcome),
  };
  const service = new RunnerService({ options: { ...DEFAULT_RUNNER_OPTIONS, killGraceMs: 2_000 } });
  service.setClient(client);
  const done = async (runId: string) => {
    await vi.waitFor(
      () => {
        expect(finished.get(runId)).toBeDefined();
      },
      { timeout: 60_000, interval: 100 },
    );
    return finished.get(runId) as RunOutcome;
  };
  return { service, outputs, done };
}

describe.runIf(hasPytest)('local test runs with pytest', () => {
  it('runs the sample project: 3 passed, 1 failed, 1 skipped, with JUnit XML and nothing else left behind', async () => {
    const root = project('all');
    const { service, outputs, done } = runner();
    const started = await service.start(root, { framework: 'pytest', selector: { kind: 'all' } });
    if (!started.ok) throw new Error(started.code);
    const outcome = await done(started.value.runId);
    expect(outcome).toMatchObject({ state: 'FAILED', exitCode: 1 });
    expect(outputs.get(started.value.runId)).toMatch(/1 failed, 3 passed, 1 skipped/);
    const junit = readFileSync(join(root, outcome.folder, 'junit.xml'), 'utf8');
    expect(junit).toMatch(/tests="5"/);
    expect(junit).toMatch(/failures="1"/);
    expect(junit).toMatch(/skipped="1"/);
    // The run's folder and nothing else: no cache, no bytecode.
    expect(existsSync(join(root, '.pytest_cache'))).toBe(false);
    expect(readdirSync(join(root, 'tests')).filter((f) => f === '__pycache__')).toEqual([]);
  });

  it('runs one file, one test or a marker expression', async () => {
    const { service, outputs, done } = runner();
    const cases = [
      [{ kind: 'node', id: 'tests/test_calculator.py::test_add' }, 'PASSED', /1 passed/],
      [{ kind: 'marker', expr: 'slow' }, 'PASSED', /1 passed, 4 deselected/],
      [{ kind: 'file', path: 'tests/test_calculator.py' }, 'FAILED', /1 failed, 3 passed, 1 skipped/],
    ] as const;
    for (const [selector, state, summary] of cases) {
      const started = await service.start(project(`select-${selector.kind}`), {
        framework: 'pytest',
        selector,
      });
      if (!started.ok) throw new Error(started.code);
      expect(await done(started.value.runId)).toMatchObject({ state });
      expect(outputs.get(started.value.runId)).toMatch(summary);
    }
  });

  it('lists the sample project’s tests', async () => {
    const { service } = runner();
    const result = await service.discover(project('discover'), 'pytest');
    expect(result).toMatchObject({ ok: true, value: { nodes: [{ id: 'tests/test_calculator.py' }] } });
    if (!result.ok) return;
    expect(result.value.nodes[0]?.children.map((c) => c.label)).toEqual([
      'test_add',
      'test_divide',
      'test_divide_by_zero',
      'test_add_negative_fails_on_purpose',
      'test_needs_network',
    ]);
    expect(result.value.problem).toBeUndefined();
  });

  it('cancels a run mid-way', async () => {
    const root = project('cancel');
    const { service, done } = runner();
    // A test that waits, written into this copy only.
    writeFileSync(
      join(root, 'tests', 'test_slow.py'),
      'import time\n\n\ndef test_waits():\n    time.sleep(60)\n',
    );
    const started = await service.start(root, {
      framework: 'pytest',
      selector: { kind: 'file', path: 'tests/test_slow.py' },
    });
    if (!started.ok) throw new Error(started.code);
    await new Promise((r) => setTimeout(r, 1_500));
    const cancelledAt = Date.now();
    await service.cancel(started.value.runId);
    expect(await done(started.value.runId)).toMatchObject({ state: 'CANCELLED' });
    expect(Date.now() - cancelledAt).toBeLessThan(10_000);
  });
});
