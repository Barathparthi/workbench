import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { openPalette, QE_COMMANDS, waitForShell, workspace } from './ide.js';

const appDir = resolve(import.meta.dirname, '../../apps/ide-electron');

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const electronBinary = createRequire(resolve(appDir, 'package.json'))('electron') as string;
  app = await electron.launch({
    executablePath: electronBinary,
    // CI runners and containers have no setuid chrome-sandbox; the flag only affects this test process.
    args: [
      appDir,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--plugins=local-dir:../../plugins',
      workspace(),
    ],
    cwd: appDir,
  });
  page = await shellWindow(app);
  await waitForShell(page);
});

/** Theia may open a splash or secondary window first; returns the window that hosts the shell. */
async function shellWindow(electronApp: ElectronApplication): Promise<Page> {
  for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
    for (const window of electronApp.windows()) {
      if ((await window.locator('#theia-app-shell').count()) > 0) return window;
    }
    await electronApp.waitForEvent('window', { timeout: 2_000 }).catch(() => undefined);
  }
  throw new Error('no Theia shell window within 90 s');
}

test.afterAll(async () => {
  await app.close();
});

test('desktop app is branded and runs in desktop mode', async () => {
  await expect(page).toHaveTitle(/QE Workspace$/);
  await expect(page.locator('#status-bar-qe-mode')).toHaveText('QE Desktop');
});

test('desktop app offers the same QE commands as the browser app', async () => {
  await openPalette(page, 'QE:');
  const rows = page.locator('.quick-input-widget .monaco-list-row');
  await expect(rows.first()).toBeVisible();
  expect((await rows.allInnerTexts()).map((t) => t.split('\n')[0])).toEqual(
    expect.arrayContaining(QE_COMMANDS),
  );
  await page.keyboard.press('Escape');
});
