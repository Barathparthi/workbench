// Drives the S1 browser app: opens the IDE, runs "QE: Say Hello" from the command palette and checks the
// notification. Usage: APP_URL=http://127.0.0.1:3000 node verify/browser.mjs [screenshot.png]
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { runHelloCommand, runTerminalCommand } from './common.mjs';

const url = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const screenshot = process.argv[2] ?? 'verify-browser.png';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const started = Date.now();
  await page.goto(url);
  const result = await runHelloCommand(page, 'browser');
  const marker = join(tmpdir(), `qe-s1-terminal-${process.pid}.txt`);
  rmSync(marker, { force: true });
  await runTerminalCommand(page, marker);
  const deadline = Date.now() + 15_000;
  while (!existsSync(marker) && Date.now() < deadline) await page.waitForTimeout(250);
  const terminalOk = existsSync(marker);
  rmSync(marker, { force: true });
  await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({ target: 'browser', url, ...result, terminalOk, totalMs: Date.now() - started, screenshot }));
} finally {
  await browser.close();
}
