// Removes build output and caches only. Unlike `git clean -xdf`, it never touches untracked source files.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const workspaceRoots = ['packages', 'extensions', 'apps', 'tests'];
const perWorkspace = ['dist', 'lib', 'src-gen', 'coverage'];
const atRoot = ['coverage', '.tsbuild', '.eslintcache'];

const removed = [];
const remove = (path) => {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  removed.push(path.slice(root.length + 1));
};

for (const name of atRoot) remove(join(root, name));
for (const group of workspaceRoots) {
  const groupDir = join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const name of perWorkspace) remove(join(root, group, entry.name, name));
  }
}
console.log(removed.length ? `clean: removed\n  ${removed.join('\n  ')}` : 'clean: nothing to remove');
