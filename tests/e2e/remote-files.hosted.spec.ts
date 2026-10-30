/**
 * Remote files end to end (PHASE_09 §Tests "E2E", 11_TESTING_STRATEGY §7 journey 5): the hosted IDE at /w/{id}/ →
 * control plane → broker → SFTP on a lab machine. Needs the full stack (docs/LOCAL_DEVELOPMENT.md) and these
 * variables; skipped without them:
 *
 *   QE_E2E_HOSTED_URL      the workspace IDE, e.g. http://localhost:8080/w/<workspace id>/
 *   QE_E2E_TARGET          the target's name (default lab-a-dev); its policy needs file_read and file_write
 *   QE_E2E_LAB_CONTAINER   the lab machine's container, for changes "on the server" (default qews-lab-a)
 *   QE_E2E_REMOTE_ROOT     the target's remoteRoot (default /home/qe)
 */
import { spawnSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

import { acceptTrust, closeRemoteSessions, runCommand, waitForShell } from './ide.js';

const url = process.env['QE_E2E_HOSTED_URL'];
const target = process.env['QE_E2E_TARGET'] ?? 'lab-a-dev';
const container = process.env['QE_E2E_LAB_CONTAINER'] ?? 'qews-lab-a';
const root = process.env['QE_E2E_REMOTE_ROOT'] ?? '/home/qe';
const dir = `${root}/qe-e2e`;

/** Runs a script on the lab machine as its user: the "side channel" the IDE does not see. */
function onServer(script: string): string {
  const r = spawnSync('docker', ['exec', '-u', 'qe', container, 'sh', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`lab script failed: ${r.stderr}`);
  return r.stdout;
}
const serverFile = () => onServer(`cat ${dir}/notes.txt`);
/** A change on the server, in a later second than anything before it (SFTP mtimes have whole seconds). */
async function changeOnServer(content: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 1_100));
  onServer(`printf '%s\\n' '${content}' > ${dir}/notes.txt`);
}

const explorer = (page: Page) => page.locator('#files');
const editorText = (page: Page) => page.locator('.monaco-editor .view-lines').first();
const dirtyTab = (page: Page) =>
  page.locator('.p-TabBar-tab.theia-mod-dirty, .lm-TabBar-tab.theia-mod-dirty');

async function openRemoteFile(page: Page): Promise<void> {
  await runCommand(page, 'Open Remote Folder');
  await page.locator('.quick-input-widget .monaco-list-row', { hasText: target }).first().click();
  // Adding a root changes the workspace, so Theia may ask for trust again.
  await acceptTrust(page);
  await runCommand(page, 'Focus on Files Explorer');
  const rootNode = explorer(page).getByText(`[${target}]`, { exact: true });
  await expect(rootNode).toBeVisible();
  const folder = explorer(page).getByText('qe-e2e', { exact: true });
  if (!(await folder.isVisible())) await rootNode.click();
  await folder.click();
  await explorer(page).getByText('notes.txt', { exact: true }).dblclick();
  await expect(editorText(page)).toContainText('hello remote');
}

test.describe('remote files (hosted)', () => {
  test.skip(url === undefined, 'needs the hosted stack: set QE_E2E_HOSTED_URL (see the file header)');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    onServer(`rm -rf ${dir} && mkdir -p ${dir} && printf 'hello remote\\n' > ${dir}/notes.txt`);
  });

  // Each test opens its own files session (new browser context); end it, or the per-user limit is reached.
  test.afterEach(async ({ request }) => {
    await closeRemoteSessions(request, url ?? '');
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(url ?? '/');
    await waitForShell(page);
  });

  test('opens the remote folder, edits and saves a file, and saves stay under 1 s (p95)', async ({
    page,
  }) => {
    await openRemoteFile(page);
    await editorText(page).click();
    await page.keyboard.press('Control+End');
    const timings: number[] = [];
    for (let i = 0; i < 10; i++) {
      await page.keyboard.type(` e${String(i)}`);
      await expect(dirtyTab(page)).toHaveCount(1);
      const started = Date.now();
      await page.keyboard.press('Control+S');
      await expect(dirtyTab(page)).toHaveCount(0);
      timings.push(Date.now() - started);
    }
    // The file ends with a newline, so Ctrl+End types on its last (empty) line.
    expect(serverFile()).toContain('hello remote\n e0 e1 e2 e3 e4 e5 e6 e7 e8 e9');
    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
    test.info().annotations.push({
      type: 'remote save ms',
      description: `${timings.join(', ')} (p95 ${String(p95)})`,
    });
    console.log(`remote save ms: ${timings.join(', ')} → p95 ${String(p95)}`);
    expect(p95).toBeLessThan(1_000);
  });

  test('reopening shows what was saved', async ({ page }) => {
    await openRemoteFile(page);
    await expect(editorText(page)).toContainText('e9');
  });

  test('a change on the server reloads a clean editor; a conflicting save asks before overwriting', async ({
    page,
  }) => {
    await openRemoteFile(page);
    await changeOnServer('changed on the server');
    // The polling watcher (5 s) reports it and Theia reloads the unmodified editor.
    await expect(editorText(page)).toContainText('changed on the server', { timeout: 20_000 });

    await editorText(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' mine');
    // The browser auto-saves after 1 s, so " mine" is usually saved just before this change, often within the same
    // (whole) SFTP mtime second: the save below must still see the change and ask.
    await changeOnServer('changed again on the server, meanwhile');

    const conflict = page.locator('.dialogOverlay', { hasText: 'has been changed on the file system' });
    await page.keyboard.press('Control+S');
    await conflict.locator('button', { hasText: 'No' }).click();
    expect(serverFile()).toBe('changed again on the server, meanwhile\n');

    await page.keyboard.press('Control+S');
    await conflict.locator('button', { hasText: 'Yes' }).click();
    await expect.poll(serverFile).toContain('mine');
  });
});
