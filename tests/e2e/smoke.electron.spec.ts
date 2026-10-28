import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { newTerminal, openPalette, preferenceRows, QE_COMMANDS, waitForShell, workspace } from './ide.js';

const appDir = resolve(import.meta.dirname, '../../apps/ide-electron');

/** Taken before the app starts: its host channel directory must be a new one. */
const tmpBefore = new Set(readdirSync(tmpdir()));
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

test('desktop app adds the desktop-only telemetry setting, off by default', async () => {
  expect(await preferenceRows(page, 'qe.telemetry.enabled')).toBe(1);
  await expect(
    page.locator('[data-pref-id="qe.telemetry.enabled"] input[type="checkbox"]'),
  ).not.toBeChecked();
});

test('desktop terminals never inherit the backend’s private channel to the main process', async () => {
  test.skip(process.platform === 'win32', 'the check uses a POSIX shell');
  // PHASE_10 §10.4: main hands the backend the channel's address and token in QE_DESKTOP_HOST; the backend removes it
  // before it starts anything, so a shell (and anything run in it) cannot talk to main's secret store.
  // The channel exists (main made its private socket directory for this run) …
  expect(readdirSync(tmpdir()).some((d) => d.startsWith('qe-host-') && !tmpBefore.has(d))).toBe(true);
  // … and the shell does not know it.
  const evidence = join(workspace(), 't-desktop-host.txt');
  rmSync(evidence, { force: true });
  await newTerminal(page);
  await page.keyboard.type('echo "host=${QE_DESKTOP_HOST:-none}" > t-desktop-host.txt');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => (existsSync(evidence) ? readFileSync(evidence, 'utf8').trim() : ''))
    .toBe('host=none');
  rmSync(evidence, { force: true });
});
