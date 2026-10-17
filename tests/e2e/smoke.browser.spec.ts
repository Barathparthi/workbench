import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  openPalette,
  pluginsAvailable,
  preferenceRows,
  QE_COMMANDS,
  runCommand,
  waitForShell,
  workspace,
} from './ide.js';
import { SEARCH_NEEDLE } from './prepare-workspace.js';

test.describe('browser IDE smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForShell(page);
  });

  test('is branded QE Workspace and offers the QE commands', async ({ page }) => {
    await expect(page).toHaveTitle(/QE Workspace$/);
    await expect(page.locator('#status-bar-qe-mode')).toHaveText('QE Local');
    await expect(page.locator('.qe-welcome .gs-section a').first()).toHaveText('Open project…');
    await openPalette(page, 'QE:');
    const rows = page.locator('.quick-input-widget .monaco-list-row');
    await expect(rows.first()).toBeVisible();
    expect((await rows.allInnerTexts()).map((t) => t.split('\n')[0])).toEqual(
      expect.arrayContaining(QE_COMMANDS),
    );
  });

  test('offers the qe.* settings, without the desktop-only telemetry switch', async ({ page }) => {
    expect(await preferenceRows(page, 'qe.runner.framework')).toBe(1);
    expect(await preferenceRows(page, 'qe.telemetry.enabled')).toBe(0);
  });

  test('explorer lists the project files', async ({ page }) => {
    await runCommand(page, 'Focus on Files Explorer');
    const explorer = page.locator('#files');
    await expect(explorer.getByText('README.md', { exact: true })).toBeVisible();
    await expect(explorer.getByText('tests', { exact: true })).toBeVisible();
  });

  test('editor saves changes to disk', async ({ page }) => {
    await page.keyboard.press('Control+P');
    await page.locator('.quick-input-widget input').waitFor({ state: 'visible' });
    await page.keyboard.type('test_sample.py');
    await page.locator('.quick-input-widget .monaco-list-row', { hasText: 'test_sample.py' }).first().click();
    const editor = page.locator('.monaco-editor .view-lines', { hasText: 'test_needle' });
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n# edited in the browser smoke test');
    await page.keyboard.press('Control+S');
    await expect
      .poll(() => readFileSync(join(workspace(), 'tests', 'test_sample.py'), 'utf8'))
      .toContain('# edited in the browser smoke test');
  });

  test('terminal runs a shell in the project folder', async ({ page }) => {
    await runCommand(page, 'Create New Terminal');
    const terminal = page.locator('.terminal-container .xterm-helper-textarea').last();
    await terminal.waitFor({ state: 'attached' });
    await terminal.focus();
    await page.keyboard.type('echo qe-$((6*7)) > terminal-marker.txt');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => readFileSync(join(workspace(), 'terminal-marker.txt'), 'utf8').trim())
      .toBe('qe-42');
  });

  test('search finds text across the project', async ({ page }) => {
    await runCommand(page, 'Find in Files');
    const search = page.locator('#search-in-workspace');
    await search.locator('textarea, input').first().waitFor({ state: 'visible' });
    await page.keyboard.type(SEARCH_NEEDLE);
    await page.keyboard.press('Enter');
    await expect(search.getByText('test_sample.py')).toBeVisible();
  });

  test('git (vscode.git plugin) lists the changed file in Source Control', async ({ page }) => {
    test.skip(!pluginsAvailable(), 'built-in plugins not downloaded (no Open VSX access here)');
    await page.keyboard.press('Control+Shift+G');
    await expect(page.locator('.theia-scm').getByText('README.md')).toBeVisible({ timeout: 60_000 });
  });

  test('talks only to its own origin', async ({ page, baseURL }) => {
    const hosts = new Set<string>();
    page.on('request', (request) => hosts.add(new URL(request.url()).host));
    await page.reload();
    await waitForShell(page);
    await openPalette(page, 'QE:');
    await page.keyboard.press('Escape');
    expect([...hosts]).toEqual([new URL(baseURL ?? '').host]);
  });
});
