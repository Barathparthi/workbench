// Two workspaces on one origin (path routing), one browser profile: open A, open B, force every WebSocket to
// reconnect, then check that BOTH workspaces still execute a backend round-trip (opening a terminal spawns a
// shell in that workspace's backend).
//   node verify-two-workspaces.mjs http://127.0.0.1:8080/w/ws-a/ http://127.0.0.1:8080/w/ws-b/
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { runHelloCommand, runTerminalCommand } from '../s1-theia-hello/verify/common.mjs';

const [urlA, urlB] = process.argv.slice(2, 4);
if (!urlA || !urlB) throw new Error('usage: node verify-two-workspaces.mjs <workspace A url> <workspace B url>');

async function terminalWorks(page, label) {
  await page.bringToFront();
  const marker = join(tmpdir(), `qe-s2-${label}-${process.pid}-${Date.now()}.txt`);
  await runTerminalCommand(page, marker);
  const deadline = Date.now() + 15_000;
  while (!existsSync(marker) && Date.now() < deadline) await page.waitForTimeout(250);
  const ok = existsSync(marker);
  rmSync(marker, { force: true });
  return ok;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  headless: true,
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const rejected = [];
  context.on('response', (r) => {
    if (r.status() === 403) rejected.push(`403 ${new URL(r.url()).pathname}`);
  });

  const pageA = await context.newPage();
  await pageA.goto(urlA);
  await runHelloCommand(pageA, 'browser');
  const cookiesAfterA = (await context.cookies()).map((c) => `${c.name} path=${c.path}`);

  const pageB = await context.newPage();
  await pageB.goto(urlB);
  await runHelloCommand(pageB, 'browser');
  const cookiesAfterB = (await context.cookies()).map((c) => `${c.name} path=${c.path}`);

  // Force a reconnect of every WebSocket (what a network blip, laptop sleep or proxy restart does).
  const sockets = { a: [], b: [] };
  pageA.on('websocket', (ws) => sockets.a.push(new URL(ws.url()).pathname));
  pageB.on('websocket', (ws) => sockets.b.push(new URL(ws.url()).pathname));
  const dropped = await (await fetch(new URL('/__spike/drop-sockets', urlA), { method: 'POST' })).json();
  await pageA.waitForTimeout(8_000);

  const result = {
    cookiesAfterA,
    cookiesAfterB,
    dropped,
    workspaceA_terminalAfterReconnect: await terminalWorks(pageA, 'a').catch((e) => `error: ${e.message.split('\n')[0]}`),
    workspaceB_terminalAfterReconnect: await terminalWorks(pageB, 'b').catch((e) => `error: ${e.message.split('\n')[0]}`),
    rejected: [...new Set(rejected)],
    webSocketsOpenedAfterDrop: sockets,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
