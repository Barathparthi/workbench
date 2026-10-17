/**
 * One Theia version everywhere (02_PHASES/PHASE_02 pitfall "different @theia/* versions in the two apps"):
 * every @theia/* dependency of the IDE apps and extensions is the same exact version, both apps ship the
 * same Theia extensions, and Electron stays on the major that @theia/electron supports.
 * Run alone with `npm run check:theia-versions`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

/** @theia/* packages only the Electron app needs. */
const ELECTRON_ONLY = new Set(['@theia/electron']);
const EXACT = /^\d+\.\d+\.\d+$/;

const theiaDeps = (m: Manifest, field: 'dependencies' | 'devDependencies') =>
  Object.entries(m[field] ?? {}).filter(([name]) => name.startsWith('@theia/'));

/** Returns human-readable problems; an empty list means the manifests agree. */
export function theiaVersionProblems(
  manifests: readonly Manifest[],
  browserApp: Manifest,
  electronApp: Manifest,
): string[] {
  const problems: string[] = [];
  const versions = new Set<string>();
  for (const m of manifests) {
    for (const [name, version] of [...theiaDeps(m, 'dependencies'), ...theiaDeps(m, 'devDependencies')]) {
      if (!EXACT.test(version)) problems.push(`${m.name}: ${name}@${version} is not an exact version`);
      versions.add(version);
    }
  }
  if (versions.size > 1) problems.push(`more than one @theia version: ${[...versions].sort().join(', ')}`);

  const runtime = (m: Manifest) =>
    new Set(
      theiaDeps(m, 'dependencies')
        .map(([name]) => name)
        .filter((name) => !ELECTRON_ONLY.has(name)),
    );
  const browserSet = runtime(browserApp);
  const electronSet = runtime(electronApp);
  for (const name of browserSet)
    if (!electronSet.has(name)) problems.push(`${electronApp.name} is missing ${name}`);
  for (const name of electronSet)
    if (!browserSet.has(name)) problems.push(`${browserApp.name} is missing ${name}`);
  if (electronApp.dependencies?.['@theia/electron'] === undefined)
    problems.push(`${electronApp.name} needs @theia/electron`);
  if (browserApp.dependencies?.['@theia/electron'] !== undefined)
    problems.push(`${browserApp.name} must not depend on @theia/electron`);
  return problems;
}

/** Electron may be overridden for security fixes, but only within the major @theia/electron supports. */
export function electronProblems(electronApp: Manifest, root: Manifest, theiaElectron: Manifest): string[] {
  const wanted = theiaElectron.peerDependencies?.['electron'];
  const actual = electronApp.devDependencies?.['electron'];
  const problems: string[] = [];
  if (wanted === undefined || actual === undefined)
    return [`electron or its @theia/electron peer range is missing`];
  if (!EXACT.test(actual)) problems.push(`electron@${actual} is not an exact version`);
  if (actual.split('.')[0] !== wanted.replace(/^[^\d]*/, '').split('.')[0]) {
    problems.push(`electron@${actual} is not on the major @theia/electron supports (${wanted})`);
  }
  if (actual !== wanted && root.overrides?.['electron'] !== actual) {
    problems.push(`electron@${actual} differs from @theia/electron's ${wanted} without a root override`);
  }
  return problems;
}

const repoRoot = resolve(import.meta.dirname, '../..');
const read = (path: string) => JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as Manifest;
const workspaceManifests = ['apps', 'extensions'].flatMap((folder) =>
  readdirSync(join(repoRoot, folder))
    .filter((d) => statSync(join(repoRoot, folder, d)).isDirectory())
    .map((d) => read(`${folder}/${d}/package.json`)),
);

const app = (name: string, deps: Record<string, string>): Manifest => ({ name, dependencies: deps });

describe('Theia versions in this repository', () => {
  it('agree across apps and extensions', () => {
    expect(
      theiaVersionProblems(
        workspaceManifests,
        read('apps/ide-browser/package.json'),
        read('apps/ide-electron/package.json'),
      ),
    ).toEqual([]);
  });

  it('keep Electron on the major @theia/electron supports', () => {
    expect(
      electronProblems(
        read('apps/ide-electron/package.json'),
        read('package.json'),
        read('node_modules/@theia/electron/package.json'),
      ),
    ).toEqual([]);
  });
});

describe('theiaVersionProblems detects drift', () => {
  const browser = app('browser', { '@theia/core': '1.76.0', '@theia/terminal': '1.76.0' });
  const electron = app('electron', {
    '@theia/core': '1.76.0',
    '@theia/terminal': '1.76.0',
    '@theia/electron': '1.76.0',
  });

  it('accepts matching apps', () => {
    expect(theiaVersionProblems([browser, electron], browser, electron)).toEqual([]);
  });

  it('flags a second Theia version', () => {
    const drifted = app('electron', { ...electron.dependencies, '@theia/terminal': '1.75.0' });
    expect(theiaVersionProblems([browser, drifted], browser, drifted)).toContain(
      'more than one @theia version: 1.75.0, 1.76.0',
    );
  });

  it('flags version ranges', () => {
    const ranged = app('ext', { '@theia/core': '^1.76.0' });
    expect(theiaVersionProblems([browser, electron, ranged], browser, electron)).toContain(
      'ext: @theia/core@^1.76.0 is not an exact version',
    );
  });

  it('flags an extension present in only one app', () => {
    const extra = app('browser', { ...browser.dependencies, '@theia/scm': '1.76.0' });
    expect(theiaVersionProblems([extra, electron], extra, electron)).toEqual([
      'electron is missing @theia/scm',
    ]);
  });

  it('flags @theia/electron in the wrong app', () => {
    const wrong = app('browser', { ...browser.dependencies, '@theia/electron': '1.76.0' });
    const without = app('electron', { '@theia/core': '1.76.0', '@theia/terminal': '1.76.0' });
    expect(theiaVersionProblems([wrong, without], wrong, without)).toEqual([
      'electron needs @theia/electron',
      'browser must not depend on @theia/electron',
    ]);
  });
});

describe('electronProblems', () => {
  const theiaElectron: Manifest = { name: '@theia/electron', peerDependencies: { electron: '42.8.1' } };
  const withElectron = (version: string): Manifest => ({
    name: 'electron-app',
    devDependencies: { electron: version },
  });

  it('accepts the peer version, or a same-major override declared at the root', () => {
    expect(electronProblems(withElectron('42.8.1'), { name: 'root' }, theiaElectron)).toEqual([]);
    expect(
      electronProblems(
        withElectron('42.11.10'),
        { name: 'root', overrides: { electron: '42.11.10' } },
        theiaElectron,
      ),
    ).toEqual([]);
  });

  it('rejects a different major, a range, or an undeclared override', () => {
    expect(
      electronProblems(
        withElectron('44.4.5'),
        { name: 'root', overrides: { electron: '44.4.5' } },
        theiaElectron,
      ),
    ).toEqual(['electron@44.4.5 is not on the major @theia/electron supports (42.8.1)']);
    expect(electronProblems(withElectron('^42.8.1'), { name: 'root' }, theiaElectron)).toContain(
      'electron@^42.8.1 is not an exact version',
    );
    expect(electronProblems(withElectron('42.11.10'), { name: 'root' }, theiaElectron)).toEqual([
      "electron@42.11.10 differs from @theia/electron's 42.8.1 without a root override",
    ]);
  });
});
