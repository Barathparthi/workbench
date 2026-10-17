// Spike S3 checks for option A (VS Code web plugin) and option B (Theia frontend extension), in the browser
// or in Electron. Every check leaves evidence on the remote host (/home/qeuser/project), which this script
// reads back from the local filesystem (the "lab host" is this machine in the spike).
//
//   node verify/check.mjs browser http://127.0.0.1:3000 out-prefix
//   xvfb-run -a node verify/check.mjs electron - out-prefix
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, chromium } from 'playwright-core';

const [target = 'browser', url = 'http://127.0.0.1:3000', outPrefix = 'verify-s3'] = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE = '/home/qeuser/project';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path, predicate, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim();
      if (predicate(text)) return { text, ms: Date.now() - t0 };
    }
    await sleep(200);
  }
  return existsSync(path) ? { text: readFileSync(path, 'utf8').trim(), ms: null } : null;
}

async function runCommand(page, label) {
  await page.keyboard.press('F1');
  await page.locator('.quick-input-widget input').waitFor({ state: 'visible', timeout: 15_000 });
  await page.keyboard.type(label);
  const row = page.locator('.quick-input-widget .monaco-list-row', { hasText: label }).first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
}

async function openPage() {
  if (target === 'browser') {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url);
    return { page, close: () => browser.close() };
  }
  const require = createRequire(import.meta.url);
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [
      resolve(root, 'electron-app'),
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      `--plugins=local-dir:${resolve(root, 'vscode-plugins')}`,
    ],
    cwd: resolve(root, 'electron-app'),
  });
  let page;
  for (const deadline = Date.now() + 90_000; !page && Date.now() < deadline; ) {
    for (const w of app.windows()) if ((await w.locator('#theia-app-shell').count()) > 0) page = w;
    if (!page) await app.waitForEvent('window', { timeout: 2_000 }).catch(() => undefined);
  }
  if (!page) throw new Error('no Theia window');
  return { page, close: () => app.close() };
}

const { page, close } = await openPage();
const results = { target };
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)));
const failedRequests = [];
page.on('response', (r) => r.status() >= 400 && failedRequests.push(`${r.status()} ${new URL(r.url()).pathname}`));
/** Each check group starts from a freshly loaded IDE so leftover editors/focus cannot affect it. */
async function freshIde() {
  // Theia stores the layout again on unload, so clearing storage + reload restores the previous group's
  // editors (a stale hello.txt editor then trips the save-conflict dialog). Reset Workbench Layout clears
  // the stored layout and reloads without storing it.
  const loaded = page.waitForEvent('load', { timeout: 60_000 });
  await runCommand(page, 'Reset Workbench Layout');
  await loaded;
  await page.waitForSelector('.theia-preload', { state: 'detached', timeout: 90_000 });
  const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
  if (await trust.isVisible().catch(() => false)) await trust.click();
  await sleep(3_000); // let frontend plugins activate
}

try {
  // Electron keeps its stored layout between runs, so even the first group resets it.
  await page.waitForSelector('.theia-preload', { state: 'detached', timeout: 90_000 });
  for (const option of (process.env.OPTIONS ?? 'A,B').split(',')) {
    await freshIde();
    const r = (results[`option${option}`] = {});
    const tag = option.toLowerCase();
    const marker = `${REMOTE}/marker-${tag}-${target}.txt`;
    const ctrlc = `${REMOTE}/ctrlc-${tag}-${target}.txt`;
    rmSync(marker, { force: true });
    rmSync(ctrlc, { force: true });
    writeFileSync(`${REMOTE}/hello.txt`, 'hello from the lab host\n');

    // 1. Remote terminal through the broker
    try {
      await runCommand(page, `QE Remote (${option}): Open Terminal`);
      await page.locator('.terminal-container .xterm-helper-textarea').last().waitFor({ timeout: 20_000 });
      await sleep(1_500);
      await page.locator('.terminal-container .xterm-helper-textarea').last().focus();
      await page.keyboard.type(`echo REMOTE_${option}_$(id -un)_$(stty size | tr ' ' x) > ${marker}`);
      await page.keyboard.press('Enter');
      const m = await waitForFile(marker, (t) => t.startsWith(`REMOTE_${option}_`));
      r.terminal = m ? { remoteFile: m.text, ms: m.ms } : 'no marker on remote host';
      // 2. Ctrl+C reaches the remote foreground job
      await page.keyboard.type('sleep 30');
      await page.keyboard.press('Enter');
      await sleep(700);
      await page.keyboard.press('Control+C');
      await page.keyboard.type(`echo CTRLC_$? > ${ctrlc}`);
      await page.keyboard.press('Enter');
      const c = await waitForFile(ctrlc, (t) => t.startsWith('CTRLC_'), 5_000);
      r.ctrlC = c ? { remoteFile: c.text, ms: c.ms } : 'not interrupted within 5s';
    } catch (e) {
      r.terminal = `error: ${e.message.split('\n')[0]}`;
    }

    // 3. Remote file: open, edit, save
    try {
      await runCommand(page, `QE Remote (${option}): Open hello.txt`);
      const editor = page.locator('.monaco-editor .view-lines', { hasText: 'hello from the lab host' }).last();
      await editor.waitFor({ timeout: 20_000 });
      r.fileOpened = true;
      await editor.click();
      r.focusBeforeTyping = await page.evaluate(() => document.activeElement?.className?.toString().slice(0, 80) ?? null);
      await page.keyboard.press('Control+End');
      await page.keyboard.type(`edited via option ${option} in ${target}`);
      await page.keyboard.press('Control+S');
      const saved = await waitForFile(`${REMOTE}/hello.txt`, (t) => t.includes(`edited via option ${option}`));
      await page.screenshot({ path: `${outPrefix}-${target}-${tag}.png` });
      if (process.env.DEBUG_SHOTS) {
        r.tabs = (await page.locator('.lm-TabBar-tab.theia-mod-active, .p-TabBar-tab.theia-mod-active').allInnerTexts()).join(' | ');
        r.dirtyTabs = await page.locator('.theia-mod-dirty').count();
        r.notifications = await page.locator('.theia-notification-message').allInnerTexts();
      }
      r.fileSaved = saved?.ms != null ? { remoteFile: saved.text.replace(/\n/g, '\\n'), ms: saved.ms } : false;
    } catch (e) {
      r.file = `error: ${e.message.split('\n')[0]}`;
    }
  }

  // 4. Webview (option A only): rendered in its own origin
  await freshIde();
  try {
    await runCommand(page, 'QE Remote (A): Open Webview');
    let found = null;
    for (let i = 0; i < 40 && !found; i++) {
      for (const f of page.frames()) {
        if ((await f.locator('#qe-webview-ok').count().catch(() => 0)) > 0) found = f;
      }
      if (!found) await sleep(500);
    }
    results.webview = found ? { origin: new URL(found.url()).origin, path: new URL(found.url()).pathname } : 'webview content not found';
    if (found) await page.screenshot({ path: `${outPrefix}-${target}-webview.png` });
  } catch (e) {
    results.webview = `error: ${e.message.split('\n')[0]}`;
  }
} finally {
  results.consoleErrors = [...new Set(consoleErrors)].slice(0, 8);
  results.failedRequests = [...new Set(failedRequests)].slice(0, 8);
  // Option A runs in Theia's frontend plugin worker; Electron never starts one (see the S3 report).
  results.pluginWorkers = page.workers().map((w) => new URL(w.url()).pathname.split('/').pop());
  console.log(JSON.stringify(results, null, 2));
  await close();
}
