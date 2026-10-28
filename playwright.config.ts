import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

// The sample repository both apps open; created by tests/e2e/prepare-workspace.ts.
const workspace = resolve(import.meta.dirname, 'test-results/e2e-workspace/sample-repo');
process.env['QE_E2E_WORKSPACE'] = workspace;
const port = 3030;
// Local web mode opens with the run's sign-in link (PHASE_10 §10.6): one token per test run, handed to the IDE backend
// the way the launcher does it. Workers load this file again and inherit the variable, so they see the same token.
process.env['QE_E2E_LOCAL_TOKEN'] ??= randomBytes(32).toString('base64url');
const localWebToken = process.env['QE_E2E_LOCAL_TOKEN'];
// The browser project's signed-in state, written by local-web.setup.ts.
const localWebState = resolve(import.meta.dirname, 'test-results/e2e-auth/local-web.json');
process.env['QE_E2E_LOCAL_STATE'] = localWebState;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // One IDE backend serves every browser test; Electron starts its own.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    // Containers that ship their own Chromium (no `playwright install`) point at it here.
    ...(process.env['CHROMIUM_PATH'] !== undefined && {
      launchOptions: { executablePath: process.env['CHROMIUM_PATH'] },
    }),
  },
  projects: [
    // Signs in once with the run's link; the browser suite starts from that cookie.
    { name: 'local-web-sign-in', testMatch: 'local-web.setup.ts' },
    {
      name: 'browser',
      testMatch: /\.browser\.spec\.ts$/,
      dependencies: ['local-web-sign-in'],
      use: { storageState: localWebState },
    },
    // Without the cookie: what local web refuses.
    { name: 'local-web-security', testMatch: 'local-web.security.spec.ts' },
    { name: 'electron', testMatch: 'smoke.electron.spec.ts' },
    // The hosted stack (control plane, broker, lab machine); remote-files.hosted.spec.ts says what it needs.
    { name: 'hosted', testMatch: /\.hosted\.spec\.ts$/ },
  ],
  webServer: {
    command: `node tests/e2e/prepare-workspace.ts "${workspace}" && node apps/ide-browser/lib/backend/main.js "${workspace}" --hostname=127.0.0.1 --port=${port} --plugins=local-dir:plugins`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    // One backend serves every browser test, and terminals outlive page reloads: raise the QE limit (default 10,
    // unit-tested) so the suite never hits it.
    // QE_E2E_HOME: a prepared home (SSH configuration for personal targets, personal-targets.browser.spec.ts).
    env: {
      QE_MAX_TERMINALS: '50',
      QE_LOCAL_WEB_TOKEN: localWebToken,
      ...(process.env['QE_E2E_HOME'] !== undefined && { HOME: process.env['QE_E2E_HOME'] }),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
