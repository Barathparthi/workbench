/**
 * Personal targets in local-web mode (PHASE_10 §10.1–10.3): a host from the user's `~/.ssh/config`, reached through
 * the embedded broker in the IDE backend — terminal and remote folder. Needs an SSH host the IDE's HOME is set up
 * for (see the variables); skipped without them:
 *
 *   QE_E2E_HOME            HOME of the IDE server: `.ssh/config` with the host, its key file and `known_hosts`
 *   QE_E2E_PERSONAL_HOST   the `Host` alias to use (its user's home holds the test files)
 *   QE_E2E_LAB_CONTAINER   the host's container, to check results "on the server" (default qews-lab-a)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { runCommand, waitForMultiRootWorkspace, waitForShell, workspace } from './ide.js';

const alias = process.env['QE_E2E_PERSONAL_HOST'];
const container = process.env['QE_E2E_LAB_CONTAINER'] ?? 'qews-lab-a';
const dir = 'qe-e2e-personal';

function onServer(script: string): string {
  const r = spawnSync('docker', ['exec', '-u', 'qe', '-w', '/home/qe', container, 'sh', '-c', script], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`lab script failed: ${r.stderr}`);
  return r.stdout;
}

async function pickPersonalHost(page: Page, command: string): Promise<void> {
  await runCommand(page, command);
  const picker = page.locator('.quick-input-widget');
  await expect(picker.getByText('Your SSH hosts')).toBeVisible();
  await picker
    .locator('.monaco-list-row', { hasText: alias ?? '' })
    .first()
    .click();
}

test.describe('personal targets (local web, embedded broker)', () => {
  test.skip(
    alias === undefined,
    'needs an SSH host: set QE_E2E_HOME and QE_E2E_PERSONAL_HOST (see the file header)',
  );
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    onServer(
      `rm -rf ${dir} /tmp/qe-personal-marker && mkdir -p ${dir} && printf 'hello personal\\n' > ${dir}/notes.txt`,
    );
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForShell(page);
  });

  test('opens a terminal to a host from ~/.ssh/config, checking its host key', async ({ page }) => {
    await pickPersonalHost(page, 'Connect to Remote System');
    const terminal = page.locator('.terminal-container .xterm-helper-textarea').last();
    await terminal.waitFor({ state: 'attached' });
    await terminal.focus();
    // Input typed before the shell exists is queued by the broker's bridge; the result is checked on the server,
    // which proves the host key was accepted too (a refused key never reaches a shell).
    await page.waitForTimeout(1_000);
    await page.keyboard.type('echo PERSONAL-$((40+2)) > /tmp/qe-personal-marker');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => onServer('cat /tmp/qe-personal-marker 2>/dev/null || true').trim())
      .toBe('PERSONAL-42');
  });

  test('asks about an unknown host key, showing its fingerprint, and connects after "Trust once"', async ({
    page,
  }) => {
    // With the host missing from known_hosts (restored afterwards), the embedded broker must ask.
    const knownHosts = join(process.env['QE_E2E_HOME'] ?? '', '.ssh', 'known_hosts');
    const saved = readFileSync(knownHosts, 'utf8');
    writeFileSync(knownHosts, '');
    try {
      const fingerprint = onServer('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub').split(' ')[1] ?? '';
      await pickPersonalHost(page, 'Connect to Remote System');
      const dialog = page.locator('.dialogOverlay', { hasText: `Unknown host key for ${alias ?? ''}` });
      await expect(dialog).toContainText(fingerprint);
      await dialog.locator('button', { hasText: 'Trust once' }).click();
      const terminal = page.locator('.terminal-container .xterm-helper-textarea').last();
      await terminal.waitFor({ state: 'attached' });
      await terminal.focus();
      await page.waitForTimeout(1_000);
      await page.keyboard.type('echo TRUSTED-ONCE > /tmp/qe-personal-marker');
      await page.keyboard.press('Enter');
      await expect
        .poll(() => onServer('cat /tmp/qe-personal-marker 2>/dev/null || true').trim())
        .toBe('TRUSTED-ONCE');
    } finally {
      writeFileSync(knownHosts, saved);
    }
  });

  test('adds a host with “Add SSH Host…” to QE’s own file, never ~/.ssh/config, and lists it', async ({
    page,
  }) => {
    const home = process.env['QE_E2E_HOME'] ?? '';
    const qeHosts = join(home, '.qe-workspace', 'ssh_hosts');
    const sshConfig = join(home, '.ssh', 'config');
    const savedHosts = existsSync(qeHosts) ? readFileSync(qeHosts, 'utf8') : undefined;
    const savedConfig = readFileSync(sshConfig, 'utf8');
    const input = page.locator('.quick-input-widget input');
    try {
      await runCommand(page, 'Add SSH Host');
      await input.fill('qe@10.99.0.1:2222');
      await page.keyboard.press('Enter');
      await expect(input).toHaveValue('10.99.0.1');
      await input.fill('e2e-added');
      await page.keyboard.press('Enter');
      await expect(page.getByText('Added e2e-added (qe@10.99.0.1:2222)').first()).toBeVisible();
      expect(readFileSync(qeHosts, 'utf8')).toContain(
        'Host e2e-added\n  HostName 10.99.0.1\n  User qe\n  Port 2222\n',
      );
      expect(readFileSync(sshConfig, 'utf8')).toBe(savedConfig);

      await runCommand(page, 'Connect to Remote System');
      const picker = page.locator('.quick-input-widget');
      await expect(picker.locator('.monaco-list-row', { hasText: 'e2e-added' })).toBeVisible();
      await expect(picker.locator('.monaco-list-row', { hasText: 'Add SSH Host…' })).toBeVisible();
      await page.keyboard.press('Escape');
    } finally {
      if (savedHosts === undefined) rmSync(qeHosts, { force: true });
      else writeFileSync(qeHosts, savedHosts);
    }
  });

  test('opens the host’s home as a remote folder and saves an edit', async ({ page }) => {
    await pickPersonalHost(page, 'Open Remote Folder');
    await waitForMultiRootWorkspace(page);
    await runCommand(page, 'Focus on Files Explorer');
    const explorer = page.locator('#files');
    const root = explorer.getByText(`[${alias ?? ''}]`, { exact: true });
    await expect(root).toBeVisible();
    const folder = explorer.getByText(dir, { exact: true });
    if (!(await folder.isVisible())) await root.click();
    await folder.click();
    await explorer.getByText('notes.txt', { exact: true }).dblclick();
    const editor = page.locator('.monaco-editor .view-lines').first();
    await expect(editor).toContainText('hello personal');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('saved from the IDE');
    await page.keyboard.press('Control+S');
    await expect.poll(() => onServer(`cat ${dir}/notes.txt`)).toContain('saved from the IDE');

    // Adding the remote root made an untitled multi-root workspace, which the IDE reopens next time: go back to the
    // sample project alone, so the other suites find the workspace they expect.
    // (Leave the page first: a change of the URL fragment alone is not a reload, and Theia would not reopen.)
    await page.goto('about:blank');
    await page.goto(`/#${workspace()}`);
    await waitForShell(page);
    await expect(page.locator('#files')).not.toContainText(`[${alias ?? ''}]`);
  });
});
