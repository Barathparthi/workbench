/**
 * Creates the sample Git repository the smoke tests open (a nested .git cannot be committed):
 * one commit, then an uncommitted change so Source Control has something to list. It holds the QE runner's sample
 * project too (tests/fixtures/sample-pytest-repo: 3 tests pass, 1 fails, 1 is skipped), for the QE Tests panel.
 * Runs on Node 24 directly: `node tests/e2e/prepare-workspace.ts <dir>`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SEARCH_NEEDLE = 'qe-smoke-needle';

export function prepareWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Sample QE project\n');
  writeFileSync(join(dir, 'tests', 'test_sample.py'), `def test_needle():\n    assert "${SEARCH_NEEDLE}"\n`);
  const sample = resolve(import.meta.dirname, '../fixtures/sample-pytest-repo');
  for (const file of ['calculator.py', 'pytest.ini', 'tests/conftest.py', 'tests/test_calculator.py'])
    cpSync(join(sample, file), join(dir, file));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=QE Smoke', '-c', 'user.email=smoke@qe.invalid', ...args], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 30_000,
    });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Initial commit');
  appendFileSync(join(dir, 'README.md'), '\nChanged by the smoke test setup.\n');
}

if (import.meta.filename === process.argv[1]) {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error('usage: node tests/e2e/prepare-workspace.ts <dir>');
  prepareWorkspace(resolve(dir));
}
