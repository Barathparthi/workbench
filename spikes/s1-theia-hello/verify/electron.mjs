// Drives the S1 Electron app: launches it, runs "QE: Say Hello" from the command palette and checks the
// notification. Needs a display; headless Linux: xvfb-run -a node verify/electron.mjs [screenshot.png] [workspace]
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

import { runHelloCommand, runTerminalCommand } from './common.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshot = process.argv[2] ?? 'verify-electron.png';
const workspace = process.argv[3];

const started = Date.now();
const app = await electron.launch({
  executablePath: require('electron'),
  // Chromium refuses to run as root without --no-sandbox (CI containers); desktop users never need it.
  args: [resolve(root, 'electron-app'), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), ...(workspace ? [workspace] : [])],
  cwd: resolve(root, 'electron-app'),
});
try {
  // Theia may open a splash window first; use the window that hosts the application shell.
  let page;
  for (const deadline = Date.now() + 90_000; !page && Date.now() < deadline; ) {
    for (const win of app.windows()) {
      if ((await win.locator('#theia-app-shell').count()) > 0) page = win;
    }
    if (!page) await app.waitForEvent('window', { timeout: 2_000 }).catch(() => undefined);
  }
  if (!page) throw new Error('No window with #theia-app-shell appeared');
  const result = await runHelloCommand(page, 'electron');
  const marker = join(tmpdir(), `qe-s1-terminal-${process.pid}.txt`);
  rmSync(marker, { force: true });
  await runTerminalCommand(page, marker);
  const deadline = Date.now() + 15_000;
  while (!existsSync(marker) && Date.now() < deadline) await page.waitForTimeout(250);
  const terminalOk = existsSync(marker);
  rmSync(marker, { force: true });
  await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({ target: 'electron', ...result, terminalOk, totalMs: Date.now() - started, screenshot }));
} finally {
  await app.close();
}
