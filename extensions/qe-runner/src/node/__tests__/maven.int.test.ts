/**
 * The runner against real Maven (P11.6): the sample Maven project (3 pass, 1 fails, 1 disabled) run in a copy, as the
 * IDE backend does it. Maven downloads its plugins and JUnit from Maven Central, which is not an approved build source
 * (org decision D12), so this runs only with QE_TEST_MAVEN=1 and `mvn` on the PATH (POSIX).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { QeRunnerClient, RunOutcome } from '../../common/qe-runner-protocol';
import { DEFAULT_RUNNER_OPTIONS, RunnerService } from '../runner-service';

const enabled =
  process.env['QE_TEST_MAVEN'] === '1' &&
  process.platform !== 'win32' &&
  spawnSync('mvn', ['-v'], { shell: false }).status === 0;
// Tests run from the repository root.
const SAMPLE = resolve('tests/fixtures/sample-maven-repo');
const dir = mkdtempSync(join(tmpdir(), 'qe-runner-maven-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(enabled)('local test runs with Maven', () => {
  it('runs the sample project: 3 passed, 1 failed, 1 skipped, the failure at its line, reports kept', async () => {
    const root = join(dir, 'project');
    cpSync(SAMPLE, root, { recursive: true });
    const finished = new Map<string, RunOutcome>();
    const client: QeRunnerClient = { onOutput: () => undefined, onFinished: (id, o) => finished.set(id, o) };
    const service = new RunnerService({ options: { ...DEFAULT_RUNNER_OPTIONS, killGraceMs: 2_000 } });
    service.setClient(client);
    expect(await service.framework(root)).toEqual({ ok: true, value: 'maven' });
    expect(await service.discover(root, 'maven')).toMatchObject({
      ok: true,
      value: { nodes: [{ id: 'com.example.CalculatorTest' }] },
    });
    const started = await service.start(root, { framework: 'maven', selector: { kind: 'all' } });
    if (!started.ok) throw new Error(started.code);
    await vi.waitFor(
      () => {
        expect(finished.get(started.value.runId)).toBeDefined();
      },
      { timeout: 600_000, interval: 500 },
    );
    const outcome = finished.get(started.value.runId);
    expect(outcome).toMatchObject({
      state: 'FAILED',
      results: { counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 } },
    });
    expect(outcome?.results?.cases).toEqual([
      expect.objectContaining({
        name: 'addsNegativesFailsOnPurpose()',
        file: 'CalculatorTest.java',
        line: 29,
      }),
    ]);
    expect(outcome?.artifacts.map((a) => a.kind)).toEqual(['junit_xml', 'log']);
  }, 660_000);
});
