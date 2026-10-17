import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page } from '@playwright/test';

export const workspace = (): string => {
  const dir = process.env['QE_E2E_WORKSPACE'];
  if (dir === undefined) throw new Error('QE_E2E_WORKSPACE is set by playwright.config.ts');
  return dir;
};

/** The built-in plugins are downloaded only where Open VSX is reachable (CI); REQUIRE_PLUGINS makes them mandatory. */
export function pluginsAvailable(): boolean {
  const dir = resolve(import.meta.dirname, '../../plugins');
  const found = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.vsix'));
  if (!found && process.env['REQUIRE_PLUGINS'] === '1')
    throw new Error('REQUIRE_PLUGINS=1 but plugins/ is empty');
  return found;
}

export const QE_COMMANDS = [
  'QE: About QE Workspace',
  'QE: Connect to Remote System…',
  'QE: Open Workspace…',
  'QE: Run Tests',
];

/** Waits for the shell and accepts Workspace Trust for the sample repository. */
export async function waitForShell(page: Page): Promise<void> {
  await page.locator('.theia-preload').waitFor({ state: 'detached', timeout: 60_000 });
  // Asked once per workspace; later loads go straight to the shell.
  const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
  await trust.click({ timeout: 5_000 }).catch(() => undefined);
  await expect(page.locator('#status-bar-qe-mode')).toBeVisible();
}

export async function openPalette(page: Page, text: string): Promise<void> {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible' });
  // fill() replaces the ">" command prefix and is ignored by Theia's quick input (spike S1); type instead.
  await page.keyboard.type(text);
}

export async function runCommand(page: Page, label: string): Promise<void> {
  await openPalette(page, label);
  await page.locator('.quick-input-widget .monaco-list-row', { hasText: label }).first().click();
}
