/**
 * Phase 06 §6.1 — the integrated terminal behaves like a real terminal. Every check writes its evidence to a file
 * in the workspace and reads it back, so assertions never depend on how xterm.js renders text.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { newTerminal, waitForShell, workspace } from './ide.js';

const file = (name: string) => join(workspace(), name);
const read = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8').trim() : '');

async function run(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

test.describe('integrated terminal (Phase 06)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForShell(page);
    await newTerminal(page);
  });

  test('runs on a real PTY with the QE terminal environment', async ({ page }) => {
    await run(
      page,
      'python3 -c "import sys; print(sys.stdin.isatty())" > t-tty.txt; echo "$TERM" > t-term.txt',
    );
    await expect.poll(() => read('t-tty.txt')).toBe('True');
    // Set by the QE terminal policy on Theia's terminal server — proves the decoration is active.
    await expect.poll(() => read('t-term.txt')).toBe('xterm-256color');
  });

  test('follows the widget size (resize reaches the shell)', async ({ page }) => {
    await run(page, 'stty size > t-size-a.txt');
    await expect.poll(() => read('t-size-a.txt')).toMatch(/^\d+ \d+$/);
    await page.setViewportSize({ width: 900, height: 560 });
    await page.waitForTimeout(1_500);
    await run(page, 'stty size > t-size-b.txt');
    await expect.poll(() => read('t-size-b.txt')).toMatch(/^\d+ \d+$/);
    const [rowsA, colsA] = read('t-size-a.txt').split(' ').map(Number);
    const [rowsB, colsB] = read('t-size-b.txt').split(' ').map(Number);
    // The bottom panel keeps its pixel height when the window shrinks, so rows may stay; the narrower window must
    // reach the shell as fewer columns (the PTY was resized), and nothing may grow.
    expect(colsB).toBeLessThan(colsA ?? 0);
    expect(rowsB).toBeLessThanOrEqual(rowsA ?? 0);
  });

  test('Ctrl+C interrupts a running command and the shell stays usable', async ({ page }) => {
    await run(page, 'sleep 30; echo slept > t-slept.txt');
    await page.waitForTimeout(1_000);
    const started = Date.now();
    await page.keyboard.press('Control+C');
    await run(page, 'echo interrupted > t-int.txt');
    await expect.poll(() => read('t-int.txt'), { timeout: 10_000 }).toBe('interrupted');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(read('t-slept.txt')).toBe('');
  });

  test('stays responsive after a flood of output', async ({ page }) => {
    await run(page, 'seq 1 200000; echo flooded > t-flood.txt');
    await expect.poll(() => read('t-flood.txt'), { timeout: 60_000 }).toBe('flooded');
    await run(page, 'echo responsive > t-resp.txt');
    await expect.poll(() => read('t-resp.txt'), { timeout: 15_000 }).toBe('responsive');
  });

  test('passes UTF-8 through unchanged', async ({ page }) => {
    await run(page, "printf 'QE \\u2713 \\u2500\\u2500 \\u00e9' > t-utf8.txt");
    await expect.poll(() => read('t-utf8.txt')).toBe('QE ✓ ── é');
  });
});
