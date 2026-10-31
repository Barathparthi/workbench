/**
 * The QE Tests panel in local web (PHASE_11 §Tests "E2E", 11_TESTING_STRATEGY §7): the project's tests listed, a run
 * from the panel with its result (3 passed, 1 failed, 1 skipped in the sample file), a failure opening the test at its
 * line, the run's record on disk, QE: Run Tests, and a cancelled run. Needs pytest where the IDE runs (python3 -m
 * pytest); skipped without it.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { runCommand, waitForShell, workspace } from './ide.js';

const hasPytest = spawnSync('python3', ['-m', 'pytest', '--version'], { shell: false }).status === 0;
const panel = (page: Page) => page.locator('#qe-tests');
const fileNode = (page: Page, file: string) => panel(page).locator('.qe-tests-tree-node', { hasText: file });

/** The newest run record under .qe-runs, read from disk: the result as the IDE backend saved it. */
function latestRecord(): {
  run: { runId: string };
  outcome: { state: string; results?: { counts: unknown } };
} {
  const runs = join(workspace(), '.qe-runs');
  const records = readdirSync(runs)
    .map((id) => join(runs, id, 'run.json'))
    .flatMap((path) => {
      try {
        return [
          JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof latestRecord> & {
            run: { startedAt: string };
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
  const [newest] = records;
  if (newest === undefined) throw new Error('no run record');
  return newest;
}

test.describe('QE Tests panel (local web)', () => {
  test.skip(!hasPytest, 'needs python3 -m pytest on this machine');
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForShell(page);
    await runCommand(page, 'Show QE Tests');
    await expect(fileNode(page, 'tests/test_calculator.py')).toBeVisible({ timeout: 30_000 });
  });

  test('runs a file from the panel, shows the result and opens a failure at its line', async ({ page }) => {
    await fileNode(page, 'tests/test_calculator.py').locator('.qe-tests-run-node').click();
    const summary = panel(page).locator('.qe-tests-summary');
    await expect(summary).toHaveText('3 passed · 1 failed · 1 skipped', { timeout: 60_000 });
    await expect(panel(page).locator('.qe-tests-output')).toContainText('1 failed, 3 passed, 1 skipped');

    await panel(page).locator('.qe-tests-failure', { hasText: 'test_add_negative_fails_on_purpose' }).click();
    await expect(
      page.locator('.lm-TabBar-tab.theia-mod-active, .p-TabBar-tab.theia-mod-active', {
        hasText: 'test_calculator.py',
      }),
    ).toBeVisible();
    await expect(page.locator('#theia-statusBar')).toContainText('Ln 21');

    // Checked outside the IDE: the record the backend saved with the run.
    expect(latestRecord().outcome).toMatchObject({
      state: 'FAILED',
      results: { counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 } },
    });
  });

  test('QE: Run Tests runs every test of the project', async ({ page }) => {
    await runCommand(page, 'QE: Run Tests');
    // The sample file, and the smoke tests' own test_sample.py (one more pass).
    await expect(panel(page).locator('.qe-tests-summary')).toHaveText('4 passed · 1 failed · 1 skipped', {
      timeout: 60_000,
    });
  });

  test('cancels a run that is still going', async ({ page }) => {
    const slow = join(workspace(), 'tests', 'test_slow_e2e.py');
    writeFileSync(slow, 'import time\n\n\ndef test_waits():\n    time.sleep(60)\n');
    try {
      await panel(page).locator('.qe-tests-refresh').click();
      await fileNode(page, 'tests/test_slow_e2e.py').locator('.qe-tests-run-node').click();
      const run = panel(page).locator('.qe-tests-run');
      await expect(run).toHaveAttribute('data-state', 'RUNNING');
      await expect(panel(page).locator('.qe-tests-output')).toContainText('collected 1 item', {
        timeout: 30_000,
      });
      await panel(page).locator('.qe-tests-cancel').click();
      await expect(run).toHaveAttribute('data-state', 'CANCELLED', { timeout: 20_000 });
      expect(latestRecord().outcome.state).toBe('CANCELLED');
    } finally {
      rmSync(slow, { force: true });
    }
  });
});
