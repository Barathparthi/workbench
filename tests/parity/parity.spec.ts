/**
 * The parity contract (01_ARCHITECTURE/09_LOCAL_AND_WEB_PARITY §2 and §4, PHASE_10 §10.8): these scenarios run
 * unchanged in hosted, local web and desktop mode (playwright.config.ts: projects parity-*). Every result is checked
 * from outside the IDE — on disk, in the workspace container, or on the lab machine — never by reading the screen.
 *
 * The QE runner's scenario (PHASE_11 §Exit criteria, Milestone M3): the pytest sample run from the QE Tests panel in
 * the project folder, its result shown and recorded.
 */
import { readFileSync } from 'node:fs';

import type { Page } from '@playwright/test';

import {
  newTerminal,
  openPalette,
  QE_COMMANDS,
  runCommand,
  VISIBLE_TERMINAL_INPUT,
  waitForMultiRootWorkspace,
  workspace,
} from '../e2e/ide.js';
import { expect, HOSTED_PROJECT, test, type RemoteTarget } from './parity.js';

test.describe.configure({ mode: 'serial' });

const REMOTE_DIR = 'qe-parity';

async function type(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** Opens a project file through Quick Open, as a user would. */
async function quickOpen(page: Page, name: string): Promise<void> {
  // A focused terminal takes Ctrl+P for its shell (the desktop window keeps its terminals between tests).
  await runCommand(page, 'Focus on Files Explorer');
  await page.keyboard.press('ControlOrMeta+P');
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

/**
 * Closes the terminal on show. Hosted terminals outlive page loads and a workspace allows 10, so every scenario closes
 * what it opens — even when it fails.
 */
async function closeTerminal(page: Page): Promise<void> {
  await runCommand(page, 'Terminal: Kill Terminal').catch(() => undefined);
}

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
  try {
    // Works in bash, zsh, PowerShell and cmd alike.
    await type(ide, 'echo parity-terminal> parity-term.txt');
    await expect.poll(() => files.read('parity-term.txt')).toBe('parity-terminal');
  } finally {
    files.remove('parity-term.txt');
    await closeTerminal(ide);
  }
});

test('interrupts a running command with Ctrl+C', async ({ ide, files, mode }) => {
  test.skip(mode === 'desktop' && process.platform === 'win32', 'the check uses a POSIX shell');
  files.remove('parity-int.txt');
  await newTerminal(ide);
  try {
    await type(ide, 'sleep 30; echo slept > parity-slept.txt');
    await ide.waitForTimeout(1_000);
    await ide.keyboard.press('Control+C');
    await type(ide, 'echo interrupted > parity-int.txt');
    await expect.poll(() => files.read('parity-int.txt'), { timeout: 10_000 }).toBe('interrupted');
    expect(files.read('parity-slept.txt')).toBe('');
  } finally {
    files.remove('parity-int.txt');
    await closeTerminal(ide);
  }
});

test('renders a webview: the Markdown preview of the README', async ({ ide, mode }) => {
  test.fixme(
    mode === 'hosted',
    'hosted webviews need their own origin: wildcard DNS and TLS for *.webview.<host> and the router (ADR-005, org decision D9)',
  );
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

/** The runner's sample project (tests/fixtures/sample-pytest-repo), written into the project folder. */
const SAMPLE = 'tests/fixtures/sample-pytest-repo';
const SAMPLE_FILES = ['calculator.py', 'pytest.ini', 'tests/conftest.py', 'tests/test_calculator.py'];

test('runs the pytest sample from the QE Tests panel and records the result', async ({ ide, files }) => {
  for (const file of SAMPLE_FILES) files.write(file, readFileSync(`${SAMPLE}/${file}`, 'utf8'));
  await runCommand(ide, 'QE: Show Tests');
  const panel = ide.locator('#qe-tests');
  const node = panel.locator('.qe-tests-tree-node', { hasText: 'tests/test_calculator.py' });
  await expect(async () => {
    await panel.locator('.qe-tests-refresh').click();
    await expect(node).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await node.locator('.qe-tests-run-node').click();
  await expect(panel.locator('.qe-tests-summary')).toHaveText('3 passed · 1 failed · 1 skipped', {
    timeout: 90_000,
  });
  // Checked outside the IDE: the record the backend saved with the run.
  await expect
    .poll(() => {
      const record = files.latestRun();
      return record === ''
        ? undefined
        : (JSON.parse(record) as { outcome: { results?: { counts: unknown } } }).outcome.results?.counts;
    })
    .toEqual({ total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 });
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
    // The terminal on show (a desktop window keeps its earlier local terminals, hidden).
    const terminal = ide.locator(VISIBLE_TERMINAL_INPUT).last();
    await terminal.waitFor({ state: 'attached' });
    try {
      await terminal.focus();
      await ide.waitForTimeout(1_000);
      await type(ide, 'echo PARITY-$((40+2)) > /tmp/qe-parity-marker');
      await expect
        .poll(() => remote.onServer('cat /tmp/qe-parity-marker 2>/dev/null || true').trim())
        .toBe('PARITY-42');
    } finally {
      await closeTerminal(ide);
    }
  });

  test('opens the remote folder, saves an edit, and refuses a link out of it', async ({
    ide,
    remote,
    page,
    mode,
  }) => {
    await pickTarget(ide, 'Open Remote Folder', remote);
    await waitForMultiRootWorkspace(ide);
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

    // Traversal denial: a link to /etc/hostname is listed, but its content never leaves the remote folder — opening it
    // says why, no editor opens for it, and the outside file's text appears nowhere.
    const hostname = remote.onServer('cat /etc/hostname').trim();
    const link = explorer.getByText('escape', { exact: true });
    await expect(link).toBeVisible();
    await link.dblclick();
    await expect(ide.getByText('“escape” points outside the remote folder').first()).toBeVisible();
    await expect(ide.locator('.lm-TabBar-tab, .p-TabBar-tab', { hasText: 'escape' })).toHaveCount(0);
    await expect(ide.locator('.monaco-editor .view-lines', { hasText: hostname })).toHaveCount(0);

    // Back to the project alone, so later tests and runs find the workspace they expect: open the project folder
    // explicitly (the IDE would otherwise reopen this multi-root workspace). Leave the page first: a change of the
    // fragment alone is no reload. The desktop window closes with its worker.
    if (mode !== 'desktop') {
      const project =
        mode === 'hosted'
          ? `${process.env['QE_E2E_HOSTED_URL'] ?? ''}#${HOSTED_PROJECT}`
          : `/#${workspace()}`;
      await page.goto('about:blank');
      await page.goto(project);
      await expect(page.locator('#theia-app-shell')).toBeVisible({ timeout: 60_000 });
    }
  });
});
