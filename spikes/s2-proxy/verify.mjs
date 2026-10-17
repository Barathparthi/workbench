// Opens the IDE through the S2 proxy, runs the S1 checks (command palette + terminal) and reports every HTTP
// request and WebSocket the page made, flagging any that left the workspace route.
//   node verify.mjs http://127.0.0.1:8080/w/test-ws/ out.png
//   node verify.mjs http://test-ws.ws.localhost:8080/ out.png
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { runHelloCommand, runTerminalCommand } from '../s1-theia-hello/verify/common.mjs';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8080/w/test-ws/');
const screenshot = process.argv[3] ?? 'verify-s2.png';
const inRoute = (raw) => {
  const u = new URL(raw);
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  return u.host === base.host && u.pathname.startsWith(base.pathname);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  headless: true,
});
const requests = [];
const sockets = [];
const failures = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('request', (r) => requests.push(r.url()));
  page.on('requestfailed', (r) => failures.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  page.on('websocket', (ws) => sockets.push(ws.url()));

  await page.goto(base.href);
  const hello = await runHelloCommand(page, 'browser');
  const marker = join(tmpdir(), `qe-s2-terminal-${process.pid}.txt`);
  rmSync(marker, { force: true });
  await runTerminalCommand(page, marker);
  const deadline = Date.now() + 15_000;
  while (!existsSync(marker) && Date.now() < deadline) await page.waitForTimeout(250);
  const terminalOk = existsSync(marker);
  rmSync(marker, { force: true });
  await page.screenshot({ path: screenshot });

  // The proxy's introspection route answers on any host; use the loopback IP so Node's DNS is not involved.
  const proxyEscapes = await (await fetch(`http://127.0.0.1:${base.port}/__spike/escapes`)).json();
  const outside = [...new Set(requests.filter((u) => !inRoute(u)))];
  console.log(
    JSON.stringify(
      {
        base: base.href,
        ...hello,
        terminalOk,
        httpRequests: requests.length,
        webSockets: [...new Set(sockets)],
        requestsOutsideRoute: outside,
        httpErrorsOrFailures: [...new Set(failures)],
        proxyEscapes,
        screenshot,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
