/**
 * Stages the desktop app for electron-builder (PHASE_10 §10.7): Theia's esbuild output in `lib/` is self-contained
 * (bundles, native modules and ripgrep), so the installer needs only `lib/` and a package.json without dependencies.
 * Packaging the workspace package itself would make electron-builder collect the monorepo's hoisted node_modules.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(appDir, 'build', 'app');
const lib = join(appDir, 'lib');

if (!existsSync(join(lib, 'backend', 'electron-main.js'))) {
  console.error('apps/ide-electron/lib is missing: run `npm run build -w @qe/ide-electron` first.');
  process.exit(1);
}

const source = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(lib, join(out, 'lib'), { recursive: true });
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'qe-workspace',
      productName: 'QE Workspace',
      version: process.env.QE_APP_VERSION ?? source.version,
      description: 'QE Workspace — the QE team’s IDE for local and remote systems.',
      author: { name: 'QE Workspace' },
      license: source.license,
      main: source.main,
    },
    null,
    2,
  )}\n`,
);
console.log(`staged ${out}`);
