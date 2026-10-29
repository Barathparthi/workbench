/**
 * The parity contract (01_ARCHITECTURE/09_LOCAL_AND_WEB_PARITY §2 and §4, PHASE_10 §10.8): these scenarios run
 * unchanged in hosted, local web and desktop mode (playwright.config.ts: projects parity-*). Every result is checked
 * from outside the IDE — on disk, in the workspace container, or on the lab machine — never by reading the screen.
 *
 * Not yet: "run the pytest sample, view results" arrives with the QE runner (Phase 11).
 */
import type { Page } from '@playwright/test';

import { acceptTrust, newTerminal, openPalette, QE_COMMANDS, runCommand } from '../e2e/ide.js';
import { expect, test, type RemoteTarget } from './parity.js';

test.describe.configure({ mode: 'serial' });

const REMOTE_DIR = 'qe-parity';

async function type(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** Opens a project file through Quick Open, as a user would. */
async function quickOpen(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Control+P');
  await page.locator('.quick-input-widget input').waitFor({ state: 'visible' });
  await page.keyboard.type(name);
  await page.locator('.quick-input-widget .monaco-list-row', { hasText: name }).first().click();
}

async function pickTarget(page: Page, command: string, remote: RemoteTarget): Promise<void> {
  await runCommand(page, command);
  const picker = page.locator('.quick-input-widget');
  await expect(
    picker.getByText(remote.kind === 'managed' ? 'Managed systems' : 'Your SSH hosts'),
  ).toBeVisible();
  await picker.locator('.monaco-list-row', { hasText: remote.name }).first().click();
}

const editor = (page: Page) => page.locator('.monaco-editor .view-lines').first();

test('offers the same QE commands', async ({ ide }) => {
  await openPalette(ide, 'QE:');
  const rows = ide.locator('.quick-input-widget .monaco-list-row');
  await expect(rows.first()).toBeVisible();
  expect((await rows.allInnerTexts()).map((t) => t.split('\n')[0])).toEqual(
    expect.arrayContaining(QE_COMMANDS),
  );
  await ide.keyboard.press('Escape');
});

test('shows a file added to the project folder in the explorer', async ({ ide, files }) => {
  files.write('parity-open.txt', 'opened\n');
  try {
    await runCommand(ide, 'Focus on Files Explorer');
    await expect(ide.locator('#files').getByText('parity-open.txt', { exact: true })).toBeVisible();
  } finally {
    files.remove('parity-open.txt');
  }
});

test('edits and saves a project file', async ({ ide, files }) => {
  files.write('parity-edit.txt', 'first line\n');
  try {
    await quickOpen(ide, 'parity-edit.txt');
    await expect(editor(ide)).toContainText('first line');
    await editor(ide).click();
    await ide.keyboard.press('Control+End');
    await ide.keyboard.type('saved by the IDE');
    await ide.keyboard.press('Control+S');
    await expect.poll(() => files.read('parity-edit.txt')).toContain('saved by the IDE');
  } finally {
    files.remove('parity-edit.txt');
  }
});

test('runs a command in the integrated terminal', async ({ ide, files }) => {
  files.remove('parity-term.txt');
  await newTerminal(ide);
  // Works in bash, zsh, PowerShell and cmd alike.
  await type(ide, 'echo parity-terminal> parity-term.txt');
  await expect.poll(() => files.read('parity-term.txt')).toBe('parity-terminal');
  files.remove('parity-term.txt');
});

test('interrupts a running command with Ctrl+C', async ({ ide, files, mode }) => {
  test.skip(mode === 'desktop' && process.platform === 'win32', 'the check uses a POSIX shell');
  files.remove('parity-int.txt');
  await newTerminal(ide);
  await type(ide, 'sleep 30; echo slept > parity-slept.txt');
  await ide.waitForTimeout(1_000);
  await ide.keyboard.press('Control+C');
  await type(ide, 'echo interrupted > parity-int.txt');
  await expect.poll(() => files.read('parity-int.txt'), { timeout: 10_000 }).toBe('interrupted');
  expect(files.read('parity-slept.txt')).toBe('');
  files.remove('parity-int.txt');
});

test('renders a webview: the Markdown preview of the README', async ({ ide }) => {
  await quickOpen(ide, 'README.md');
  await expect(editor(ide)).toContainText('Sample QE project');
  // The Markdown plugin's own key (Theia's palette does not list this plugin's when-scoped commands). Plugins load
  // after the shell, so press it until the preview opens.
  const webview = ide.locator('iframe.webview');
  await expect(async () => {
    await editor(ide).click();
    await ide.keyboard.press('ControlOrMeta+Shift+V');
    await expect(webview).toHaveCount(1, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  // Webviews live on their own origin (local web: <id>.webview.localhost); the preview is a frame inside it.
  const preview = ide.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
  await expect(preview.locator('h1')).toHaveText('Sample QE project', { timeout: 30_000 });
});

test.describe('remote system', () => {
  test.beforeEach(({ remote }) => {
    remote.onServer(
      `rm -rf ${REMOTE_DIR} /tmp/qe-parity-marker && mkdir -p ${REMOTE_DIR} ` +
        `&& printf 'hello parity\\n' > ${REMOTE_DIR}/notes.txt && ln -s /etc/hostname ${REMOTE_DIR}/escape`,
    );
  });

  test('opens a terminal on the target', async ({ ide, remote }) => {
    await pickTarget(ide, 'Connect to Remote System', remote);
    const terminal = ide.locator('.terminal-container .xterm-helper-textarea').last();
    await terminal.waitFor({ state: 'attached' });
    await terminal.focus();
    await ide.waitForTimeout(1_000);
    await type(ide, 'echo PARITY-$((40+2)) > /tmp/qe-parity-marker');
    await expect
      .poll(() => remote.onServer('cat /tmp/qe-parity-marker 2>/dev/null || true').trim())
      .toBe('PARITY-42');
  });

  test('opens the remote folder, saves an edit, and refuses a link out of it', async ({
    ide,
    remote,
    page,
  }) => {
    await pickTarget(ide, 'Open Remote Folder', remote);
    await acceptTrust(ide);
    await runCommand(ide, 'Focus on Files Explorer');
    const explorer = ide.locator('#files');
    const root = explorer.getByText(`[${remote.name}]`, { exact: true });
    await expect(root).toBeVisible();
    const folder = explorer.getByText(REMOTE_DIR, { exact: true });
    if (!(await folder.isVisible())) await root.click();
    await folder.click();

    await explorer.getByText('notes.txt', { exact: true }).dblclick();
    await expect(editor(ide)).toContainText('hello parity');
    await editor(ide).click();
    await ide.keyboard.press('Control+End');
    await ide.keyboard.type('saved remotely');
    await ide.keyboard.press('Control+S');
    await expect.poll(() => remote.onServer(`cat ${REMOTE_DIR}/notes.txt`)).toContain('saved remotely');

    // Traversal denial: a link to /etc/hostname is listed, but its content never leaves the remote folder — no editor
    // opens for it, and the outside file's text appears nowhere. (Opening it shows no message yet: review item.)
    const hostname = remote.onServer('cat /etc/hostname').trim();
    const link = explorer.getByText('escape', { exact: true });
    await expect(link).toBeVisible();
    await link.dblclick();
    await ide.waitForTimeout(3_000);
    await expect(ide.locator('.lm-TabBar-tab, .p-TabBar-tab', { hasText: 'escape' })).toHaveCount(0);
    await expect(ide.locator('.monaco-editor .view-lines', { hasText: hostname })).toHaveCount(0);

    // Back to the project alone, so later runs find the workspace they expect (a hash change is no reload).
    if (ide === page) {
      await page.goto('about:blank');
      await page.goto('/');
    }
  });
});
