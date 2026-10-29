/**
 * `decompress` as Theia loads it (`require('decompress')`, @theia/plugin-ext, plugin-ext-vscode, cli): the root
 * override puts vendor/decompress-compat in its place, on the patched @xhmikosr/decompress. The original 4.2.1
 * writes outside the target folder for crafted entries (GHSA-mp2f-45pm-3cg9, GHSA-h39j-r5qq-r9mm,
 * GHSA-jwp9-9v96-94mx, GHSA-hrh2-vp3x-79xf); these archives try exactly that.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Decompress = (
  input: string,
  output?: string | { filter?: (file: { path: string }) => boolean },
  options?: object,
) => Promise<{ path: string; data: Buffer }[]>;
const decompress = createRequire(import.meta.url)('decompress') as Decompress;

/** One ustar entry: a file ('0'), a hard link ('1') or a symlink ('2'). */
function tarEntry(name: string, type: '0' | '1' | '2', content = '', link = ''): Buffer {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  const put = (text: string, offset: number, length: number) => {
    header.write(text.slice(0, length), offset, 'utf8');
  };
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0');
  put(name, 0, 100);
  put(octal(type === '2' ? 0o777 : 0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(type === '0' ? data.length : 0, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  header.fill(' ', 148, 156);
  put(type, 156, 1);
  put(link, 157, 100);
  put('ustar\u000000', 257, 8);
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(`${octal(sum, 7)}\u0000 `, 148, 8);
  const padded =
    type === '0' ? Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]) : Buffer.alloc(0);
  return Buffer.concat([header, padded]);
}

let root: string;
let target: string;
const archive = (name: string, entries: Buffer[]) => {
  const path = join(root, name);
  writeFileSync(path, Buffer.concat([...entries, Buffer.alloc(1024)]));
  return path;
};
const attempt = (input: string) => decompress(input, target).catch((error: unknown) => error);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qe-decompress-'));
  target = join(root, 'target', 'plugin');
  mkdirSync(target, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('decompress (vendor/decompress-compat on @xhmikosr/decompress)', () => {
  it('extracts a plugin archive into the target folder, as Theia expects', async () => {
    const input = archive('plugin.tar', [
      tarEntry('extension/package.json', '0', '{"name":"p","version":"1.0.0"}'),
    ]);
    const files = await decompress(input, target);
    expect(files.map((f) => f.path)).toEqual(['extension/package.json']);
    expect(readFileSync(join(target, 'extension', 'package.json'), 'utf8')).toContain('"name":"p"');
  });

  it('returns the files without writing when called with a filter only (plugin-ext-vscode’s use)', async () => {
    const input = archive('plugin.tar', [
      tarEntry('extension/package.json', '0', '{"name":"p"}'),
      tarEntry('extension/readme.md', '0', 'hello'),
    ]);
    const files = await decompress(input, { filter: (file) => file.path === 'extension/package.json' });
    expect(files.map((f) => [f.path, f.data.toString()])).toEqual([
      ['extension/package.json', '{"name":"p"}'],
    ]);
  });

  it('never writes outside the target folder through ../ entries (Zip Slip)', async () => {
    await attempt(archive('slip.tar', [tarEntry('../../escaped.txt', '0', 'pwned')]));
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false);
    expect(existsSync(join(root, 'target', 'escaped.txt'))).toBe(false);
  });

  it('never writes through an absolute path', async () => {
    const outside = join(root, 'absolute.txt');
    await attempt(archive('absolute.tar', [tarEntry(outside, '0', 'pwned')]));
    expect(existsSync(outside)).toBe(false);
  });

  it('never writes through a symlink that points out of the target folder (symlink chain)', async () => {
    mkdirSync(join(root, 'outside'));
    await attempt(
      archive('chain.tar', [
        tarEntry('link', '2', '', '../../outside'),
        tarEntry('link/pwned.txt', '0', 'pwned'),
      ]),
    );
    expect(existsSync(join(root, 'outside', 'pwned.txt'))).toBe(false);
  });

  it('never links to a file outside the target folder (hard links)', async () => {
    writeFileSync(join(root, 'secret.txt'), 'secret');
    await attempt(archive('hardlink.tar', [tarEntry('copy.txt', '1', '', '../../secret.txt')]));
    const copy = join(target, 'copy.txt');
    expect(existsSync(copy) ? readFileSync(copy, 'utf8') : '').not.toBe('secret');
  });
});
