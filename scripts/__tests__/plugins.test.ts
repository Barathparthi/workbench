import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  downloadPlugins,
  extractZip,
  lockPlugins,
  parseManifest,
  PluginError,
  registryBase,
  sha256Of,
  vsixUrl,
  type PluginSpec,
} from '../plugins.js';

interface ZipEntry {
  name: string;
  data?: string;
  method?: number;
  mode?: number;
  flags?: number;
  crc?: number;
}

/** Writes a minimal ZIP (no ZIP64) so the extractor can be tested without fixtures on disk. */
function makeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data ?? '');
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name);
    const crc = entry.crc ?? crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.flags ?? 0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const vsix = (name: string) =>
  makeZip([
    { name: 'extension.vsixmanifest', data: `<PackageManifest>${name}</PackageManifest>` },
    { name: 'extension/', mode: 0o040755 },
    {
      name: 'extension/package.json',
      data: JSON.stringify({ name, publisher: 'vscode', version: '1.95.3' }),
    },
  ]);
const GIT = vsix('git');
const YAML = vsix('yaml');
const spec = (id: string, bytes: Buffer, version = '1.95.3'): PluginSpec => ({
  id,
  version,
  sha256: sha256Of(bytes),
});

/** A stub Open VSX registry on loopback; `routes` maps request paths to responses. */
let server: Server;
let base: URL;
const requests: string[] = [];
const routes = new Map<string, (res: ServerResponse) => void>();

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const route = routes.get(req.url ?? '');
    if (route) route(res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = registryBase(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) =>
    server.close(() => {
      done();
    }),
  );
});

let outDir: string;
beforeEach(async () => {
  requests.length = 0;
  routes.clear();
  routes.set('/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix', (res) => res.end(GIT));
  routes.set('/api/vscode/yaml/1.95.3/file/vscode.yaml-1.95.3.vsix', (res) => res.end(YAML));
  outDir = await mkdtemp(join(tmpdir(), 'qe-plugins-'));
  return () => rm(outDir, { recursive: true, force: true });
});

describe('parseManifest', () => {
  const valid = { plugins: [{ id: 'vscode.git', version: '1.95.3', sha256: 'a'.repeat(64) }] };

  it('accepts pinned entries', () => {
    expect(parseManifest(valid)).toEqual(valid.plugins);
  });

  it.each([
    [{}, '"plugins" must be a non-empty array'],
    [{ plugins: [] }, '"plugins" must be a non-empty array'],
    [
      { plugins: [{ id: 'git', version: '1.95.3', sha256: 'a'.repeat(64) }] },
      'id must be "<namespace>.<name>"',
    ],
    [
      { plugins: [{ id: '../evil.x', version: '1.95.3', sha256: 'a'.repeat(64) }] },
      'id must be "<namespace>.<name>"',
    ],
    [{ plugins: [{ id: 'vscode.git', version: 'latest', sha256: 'a'.repeat(64) }] }, 'version must be x.y.z'],
    [
      { plugins: [{ id: 'vscode.git', version: '^1.95.3', sha256: 'a'.repeat(64) }] },
      'version must be x.y.z',
    ],
    [{ plugins: [{ id: 'vscode.git', version: '1.95.3', sha256: '' }] }, 'sha256 must be 64 lower-case hex'],
    [
      { plugins: [{ id: 'vscode.git', version: '1.95.3', sha256: 'A'.repeat(64) }] },
      'sha256 must be 64 lower-case hex',
    ],
    [{ plugins: [...valid.plugins, ...valid.plugins] }, 'duplicate id vscode.git'],
  ])('rejects %j', (json, message) => {
    expect(() => parseManifest(json)).toThrow(message);
  });

  it('allows missing hashes only for locking', () => {
    const unlocked = { plugins: [{ id: 'vscode.git', version: '1.95.3', sha256: '' }] };
    expect(parseManifest(unlocked, { allowMissingHashes: true })[0]?.sha256).toBe('');
  });
});

describe('registryBase', () => {
  it.each([
    'https://open-vsx.org',
    'https://mirror.corp/openvsx/',
    'http://localhost:3001',
    'http://127.0.0.1:9',
  ])('accepts %s', (url) => {
    expect(registryBase(url).href.endsWith('/')).toBe(true);
  });

  it.each([
    [undefined, 'QE_VSX_URL is not set'],
    ['', 'QE_VSX_URL is not set'],
    ['open-vsx.org', 'must be an absolute URL'],
    ['http://open-vsx.org', 'must use https'],
    ['file:///tmp/registry', 'must use https'],
    ['https://user:pw@mirror.corp', 'must not contain credentials'],
  ])('rejects %s', (url, message) => {
    expect(() => registryBase(url)).toThrow(message);
  });

  it('builds Open VSX file URLs under the base path', () => {
    expect(vsixUrl(registryBase('https://mirror.corp/openvsx'), spec('vscode.git', GIT)).href).toBe(
      'https://mirror.corp/openvsx/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix',
    );
  });
});

describe('downloadPlugins', () => {
  const packageJson = (id: string) => readFile(join(outDir, id, 'extension', 'package.json'), 'utf8');

  it('downloads each pinned plugin, verifies its hash and unpacks it for Theia', async () => {
    const result = await downloadPlugins([spec('vscode.git', GIT), spec('vscode.yaml', YAML)], base, outDir);
    expect(result).toEqual({ downloaded: ['vscode.git', 'vscode.yaml'], kept: [], removed: [] });
    expect(JSON.parse(await packageJson('vscode.git'))).toMatchObject({ name: 'git' });
    expect((await readdir(join(outDir, 'vscode.git'))).sort()).toEqual([
      '.qe-sha256',
      'extension',
      'extension.vsixmanifest',
    ]);
    expect((await readdir(outDir)).sort()).toEqual(['vscode.git', 'vscode.yaml']);
  });

  it('keeps a plugin already unpacked from the pinned archive, without network', async () => {
    await downloadPlugins([spec('vscode.git', GIT)], base, outDir);
    requests.length = 0;
    expect(await downloadPlugins([spec('vscode.git', GIT)], base, outDir)).toMatchObject({
      kept: ['vscode.git'],
    });
    expect(requests).toEqual([]);
  });

  it('replaces a plugin unpacked from another archive', async () => {
    await mkdir(join(outDir, 'vscode.git'));
    await writeFile(join(outDir, 'vscode.git', '.qe-sha256'), 'f'.repeat(64));
    await writeFile(join(outDir, 'vscode.git', 'stale.txt'), 'old');
    expect(await downloadPlugins([spec('vscode.git', GIT)], base, outDir)).toMatchObject({
      downloaded: ['vscode.git'],
    });
    expect(await readdir(join(outDir, 'vscode.git'))).not.toContain('stale.txt');
  });

  it('removes anything that is not in the manifest', async () => {
    await mkdir(join(outDir, 'evil.extension'));
    await writeFile(join(outDir, 'evil.vsix'), 'x');
    await writeFile(join(outDir, '.vscode.git.unpack'), 'x');
    const result = await downloadPlugins([spec('vscode.git', GIT)], base, outDir);
    expect(result.removed.sort()).toEqual(['.vscode.git.unpack', 'evil.extension', 'evil.vsix']);
    expect(await readdir(outDir)).toEqual(['vscode.git']);
  });

  it('fails on a hash mismatch and unpacks nothing', async () => {
    const pinned = { ...spec('vscode.git', GIT), sha256: sha256Of(Buffer.from('something else')) };
    await expect(downloadPlugins([pinned], base, outDir)).rejects.toThrow('does not match the pinned');
    expect(await readdir(outDir)).toEqual([]);
  });

  it('leaves no partial plugin when the archive is bad', async () => {
    const broken = makeZip([{ name: '../escape.txt', data: 'x' }]);
    routes.set('/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix', (res) => res.end(broken));
    await expect(downloadPlugins([spec('vscode.git', broken)], base, outDir)).rejects.toThrow(
      'escapes the destination',
    );
    expect(await readdir(outDir)).toEqual([]);
  });

  it('fails when the registry does not have the version', async () => {
    await expect(downloadPlugins([spec('vscode.git', GIT, '9.9.9')], base, outDir)).rejects.toThrow(
      'returned 404',
    );
  });

  it('fails when a download is larger than the limit', async () => {
    const big = Buffer.alloc(2048, 1);
    routes.set('/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix', (res) => res.end(big));
    await expect(
      downloadPlugins([spec('vscode.git', big)], base, outDir, { timeoutMs: 5_000, maxBytes: 1024 }),
    ).rejects.toThrow('exceeds 1024');
  });

  it('fails when the registry stops answering', async () => {
    routes.set('/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix', () => undefined);
    await expect(
      downloadPlugins([spec('vscode.git', GIT)], base, outDir, { timeoutMs: 200, maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('follows a redirect to blob storage, as Open VSX does', async () => {
    routes.set('/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix', (res) =>
      res.writeHead(302, { location: '/blobs/vscode.git-1.95.3.vsix' }).end(),
    );
    routes.set('/blobs/vscode.git-1.95.3.vsix', (res) => res.end(GIT));
    expect(await downloadPlugins([spec('vscode.git', GIT)], base, outDir)).toMatchObject({
      downloaded: ['vscode.git'],
    });
  });

  it('refuses a redirect to plain http before connecting to it', async () => {
    routes.set('/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix', (res) =>
      res.writeHead(302, { location: 'http://example.invalid/vscode.git.vsix' }).end(),
    );
    await expect(downloadPlugins([spec('vscode.git', GIT)], base, outDir)).rejects.toThrow(
      /redirect from .* must use https/,
    );
  });

  it('gives up on redirect loops', async () => {
    routes.set('/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix', (res) =>
      res.writeHead(302, { location: '/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix' }).end(),
    );
    await expect(downloadPlugins([spec('vscode.git', GIT)], base, outDir)).rejects.toThrow(
      'more than 5 redirects',
    );
  });
});

describe('extractZip', () => {
  it('unpacks stored and deflated files and directories', async () => {
    const zip = makeZip([
      { name: 'a/', mode: 0o040755 },
      { name: 'a/stored.txt', data: 'stored', method: 0 },
      { name: 'a/b/deflated.txt', data: 'deflated '.repeat(100) },
      { name: 'empty.txt', data: '' },
    ]);
    expect(await extractZip(zip, outDir)).toBe(4);
    expect(await readFile(join(outDir, 'a', 'stored.txt'), 'utf8')).toBe('stored');
    expect(await readFile(join(outDir, 'a', 'b', 'deflated.txt'), 'utf8')).toBe('deflated '.repeat(100));
    expect(await readFile(join(outDir, 'empty.txt'), 'utf8')).toBe('');
  });

  it.each([
    ['../escape.txt', 'escapes the destination'],
    ['a/../../escape.txt', 'escapes the destination'],
    ['/etc/passwd', 'escapes the destination'],
    ['C:/Windows/x', 'escapes the destination'],
    ['a\\..\\b', 'escapes the destination'],
  ])('refuses the entry name %s', async (name, message) => {
    await expect(extractZip(makeZip([{ name, data: 'x' }]), outDir)).rejects.toThrow(message);
  });

  it.each([
    [{ name: 'link', data: '/etc/passwd', mode: 0o120777 }, 'is a symbolic link'],
    [{ name: 'secret.txt', data: 'x', flags: 0x1 }, 'is encrypted'],
    [{ name: 'bz.txt', data: 'x', method: 12 }, 'unsupported compression method 12'],
    [{ name: 'crc.txt', data: 'x', crc: 1 }, 'fails its CRC check'],
  ])('refuses %j', async (entry, message) => {
    await expect(extractZip(makeZip([entry]), outDir)).rejects.toThrow(message);
  });

  it('refuses data that is not a ZIP', async () => {
    await expect(extractZip(Buffer.from('not a zip at all, just text'), outDir)).rejects.toThrow(
      'no end of central directory',
    );
  });

  it('enforces the entry and size limits', async () => {
    const zip = makeZip([
      { name: 'one.txt', data: 'x'.repeat(600) },
      { name: 'two.txt', data: 'y'.repeat(600) },
    ]);
    await expect(extractZip(zip, outDir, { maxEntries: 1, maxTotalBytes: 10_000 })).rejects.toThrow(
      'more than 1 entries',
    );
    await expect(extractZip(zip, outDir, { maxEntries: 10, maxTotalBytes: 1_000 })).rejects.toThrow(
      'more than 1000 bytes when unpacked',
    );
  });
});

describe('lockPlugins', () => {
  it('returns the registry hash for each entry', async () => {
    const unlocked: PluginSpec[] = [{ id: 'vscode.git', version: '1.95.3', sha256: '' }];
    expect(await lockPlugins(unlocked, base)).toEqual([spec('vscode.git', GIT)]);
  });
});
