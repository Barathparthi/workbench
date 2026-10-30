/**
 * Fixtures of the parity suite (01_ARCHITECTURE/09_LOCAL_AND_WEB_PARITY §4): one set of scenarios, run in each mode.
 * The `mode` option picks how the IDE is reached and how the test looks at results "from outside":
 *
 *   hosted     the workspace IDE at QE_E2E_HOSTED_URL (dev stack); its files through QE_E2E_HOSTED_CONTAINER;
 *              the remote target is the managed QE_E2E_TARGET (default lab-a-dev)
 *   local-web  the browser app the Playwright web server starts, signed in with the run's link
 *   desktop    the Electron app, launched once per worker with its own user data
 *
 * In the two local modes the remote target is the personal host QE_E2E_PERSONAL_HOST from the prepared HOME
 * (QE_E2E_HOME); both run on the lab machine QE_E2E_LAB_CONTAINER (default qews-lab-a) as its user qe.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { closeRemoteSessions, waitForShell, workspace } from '../e2e/ide.js';

export type Mode = 'hosted' | 'local-web' | 'desktop';
export interface ParityOptions {
  readonly mode: Mode;
}

/** The project folder the IDE has open, seen from outside the IDE. */
export interface ProjectFiles {
  read(name: string): string;
  write(name: string, content: string): void;
  remove(name: string): void;
}

/** The SSH target the scenarios use, and a side channel to its machine. */
export interface RemoteTarget {
  readonly name: string;
  readonly kind: 'managed' | 'personal';
  /** Runs a script as the target's user, in its home (the remote folder's root). */
  onServer(script: string): string;
}

const appDir = resolve(import.meta.dirname, '../../apps/ide-electron');
/** The project folder in the hosted workspace runtime. */
export const HOSTED_PROJECT = '/home/qe/project';
const labContainer = process.env['QE_E2E_LAB_CONTAINER'] ?? 'qews-lab-a';

function docker(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args[0] ?? ''} failed: ${r.stderr}`);
  return r.stdout;
}

/** Text a shell wrote: UTF-8, or UTF-16 with a BOM (Windows PowerShell's `>`). */
function decode(bytes: Buffer): string {
  return bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString('utf16le')
    : bytes.toString('utf8');
}

function localFiles(dir: string): ProjectFiles {
  return {
    read: (name) => (existsSync(join(dir, name)) ? decode(readFileSync(join(dir, name))).trim() : ''),
    write: (name, content) => {
      writeFileSync(join(dir, name), content);
    },
    remove: (name) => {
      rmSync(join(dir, name), { force: true });
    },
  };
}

function containerFiles(container: string, dir: string): ProjectFiles {
  const sh = (script: string) => docker(['exec', '-u', '1000', '-w', dir, container, 'sh', '-c', script]);
  return {
    read: (name) => sh(`cat '${name}' 2>/dev/null || true`).trim(),
    write: (name, content) => {
      const r = spawnSync(
        'docker',
        ['exec', '-i', '-u', '1000', '-w', dir, container, 'sh', '-c', `cat > '${name}'`],
        {
          input: content,
        },
      );
      if (r.status !== 0) throw new Error('writing into the workspace failed');
    },
    remove: (name) => sh(`rm -f '${name}'`),
  };
}

/** Theia may open a splash or secondary window first; returns the window that hosts the shell. */
async function shellWindow(app: ElectronApplication): Promise<Page> {
  for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
    for (const window of app.windows()) {
      if ((await window.locator('#theia-app-shell').count()) > 0) return window;
    }
    await app.waitForEvent('window', { timeout: 2_000 }).catch(() => undefined);
  }
  throw new Error('no Theia shell window within 90 s');
}

export const test = base.extend<
  { ide: Page; files: ProjectFiles; remote: RemoteTarget },
  ParityOptions & { desktop: ElectronApplication | undefined }
>({
  mode: ['local-web', { option: true, scope: 'worker' }],

  desktop: [
    async ({ mode }, use) => {
      if (mode !== 'desktop') {
        await use(undefined);
        return;
      }
      const electronBinary = createRequire(join(appDir, 'package.json'))('electron') as string;
      const userData = mkdtempSync(join(tmpdir(), 'qe-parity-desktop-'));
      const home = process.env['QE_E2E_HOME'];
      const app = await electron.launch({
        executablePath: electronBinary,
        args: [
          // Starts apps/ide-electron's main so that Theia opens workspace() (desktop-launcher/main.cjs says why).
          resolve(import.meta.dirname, 'desktop-launcher'),
          ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
          `--electronUserData=${userData}`,
          '--plugins=local-dir:../../plugins',
          workspace(),
        ],
        cwd: appDir,
        // Personal targets come from the prepared HOME, as in local web.
        env: { ...process.env, ...(home !== undefined && { HOME: home, USERPROFILE: home }) },
      });
      await use(app);
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],

  ide: async ({ mode, page, desktop, request }, use, testInfo) => {
    if (mode === 'desktop') {
      const shell = await shellWindow(desktop as ElectronApplication);
      await waitForShell(shell);
      await expect(shell).toHaveTitle(new RegExp(basename(workspace())));
      await use(shell);
      return;
    }
    const url = mode === 'hosted' ? process.env['QE_E2E_HOSTED_URL'] : '/';
    testInfo.skip(url === undefined, 'hosted mode needs the dev stack: set QE_E2E_HOSTED_URL');
    // Hosted: name the project folder, or Theia reopens the workspace used last (another suite's remote folders).
    await page.goto(mode === 'hosted' ? `${url ?? ''}#${HOSTED_PROJECT}` : '/');
    await waitForShell(page);
    await use(page);
    if (mode === 'hosted' && url !== undefined) await closeRemoteSessions(request, url);
  },

  files: async ({ mode }, use, testInfo) => {
    if (mode !== 'hosted') {
      await use(localFiles(workspace()));
      return;
    }
    const container = process.env['QE_E2E_HOSTED_CONTAINER'];
    testInfo.skip(
      container === undefined,
      'hosted mode needs QE_E2E_HOSTED_CONTAINER (the workspace runtime)',
    );
    await use(containerFiles(container ?? '', HOSTED_PROJECT));
  },

  remote: async ({ mode }, use, testInfo) => {
    // Checked before the scenarios' beforeEach reaches the lab machine: without the stack there is none.
    testInfo.skip(
      mode === 'hosted' && process.env['QE_E2E_HOSTED_URL'] === undefined,
      'hosted mode needs the dev stack: set QE_E2E_HOSTED_URL',
    );
    const personal = process.env['QE_E2E_PERSONAL_HOST'];
    const name = mode === 'hosted' ? (process.env['QE_E2E_TARGET'] ?? 'lab-a-dev') : personal;
    testInfo.skip(
      name === undefined,
      'needs an SSH host: QE_E2E_HOME and QE_E2E_PERSONAL_HOST (local modes)',
    );
    await use({
      name: name ?? '',
      kind: mode === 'hosted' ? 'managed' : 'personal',
      onServer: (script) => docker(['exec', '-u', 'qe', '-w', '/home/qe', labContainer, 'sh', '-c', script]),
    });
  },
});

export { expect };
