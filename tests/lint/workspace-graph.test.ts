/**
 * Keeps the three descriptions of the package graph in sync: what the code imports, what package.json
 * declares and what tsconfig references. TypeScript does not fail on a missing project reference when
 * packages resolve to source, so this test is the guard.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface TsConfig {
  references?: { path: string }[];
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** Library packages are `@qe/<dir>`; Theia extensions are `@qe/theia-<dir>` (02_PHASES/PHASE_02 §2.1). */
const workspaces = [
  { folder: 'packages', namePrefix: '@qe/' },
  { folder: 'extensions', namePrefix: '@qe/theia-' },
].flatMap(({ folder, namePrefix }) => {
  const dir = join(repoRoot, folder);
  return readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory())
    .map((d) => ({ path: `${folder}/${d}`, expectedName: `${namePrefix}${d}` }));
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function importedWorkspacePackages(dir: string, self: string): Set<string> {
  const specifier = /(?:from\s+|import\s*\(\s*|import\s+)['"](@qe\/[a-z0-9-]+)['"]/g;
  const found = new Set<string>();
  for (const file of sourceFiles(join(dir, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(specifier)) {
      const name = match[1];
      if (name !== undefined && name !== self) found.add(name);
    }
  }
  return found;
}

describe.each(workspaces)('$path', ({ path, expectedName }) => {
  const root = join(repoRoot, path);
  const pkg = readJson(join(root, 'package.json')) as PackageJson;
  const tsconfig = readJson(join(root, 'tsconfig.json')) as TsConfig;

  const declared = new Set(
    [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter((d) =>
      d.startsWith('@qe/'),
    ),
  );
  const referenced = new Set(
    (tsconfig.references ?? []).map(
      (r) => (readJson(join(root, r.path, 'package.json')) as PackageJson).name,
    ),
  );

  it('is named after its folder', () => {
    expect(pkg.name).toBe(expectedName);
  });

  it('references exactly the workspace packages it declares', () => {
    expect([...referenced].sort()).toEqual([...declared].sort());
  });

  it('declares every workspace package its sources import', () => {
    const missing = [...importedWorkspacePackages(root, pkg.name)].filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  it('is part of the root build graph', () => {
    const build = readJson(join(repoRoot, 'tsconfig.build.json')) as TsConfig;
    expect(build.references?.map((r) => r.path)).toContain(path);
  });
});
