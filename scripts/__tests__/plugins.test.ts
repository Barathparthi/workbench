import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  downloadPlugins,
  lockPlugins,
  parseManifest,
  PluginError,
  registryBase,
  sha256Of,
  vsixUrl,
  type PluginSpec,
} from '../plugins.js';

const GIT = Buffer.from('fake vsix: vscode.git');
const YAML = Buffer.from('fake vsix: vscode.yaml');
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
  it('downloads each pinned plugin and verifies its hash', async () => {
    const result = await downloadPlugins([spec('vscode.git', GIT), spec('vscode.yaml', YAML)], base, outDir);
    expect(result).toEqual({ downloaded: ['vscode.git', 'vscode.yaml'], kept: [], removed: [] });
    expect(await readFile(join(outDir, 'vscode.git.vsix'))).toEqual(GIT);
    expect((await readdir(outDir)).sort()).toEqual(['vscode.git.vsix', 'vscode.yaml.vsix']);
  });

  it('keeps files that already match and skips the network for them', async () => {
    await writeFile(join(outDir, 'vscode.git.vsix'), GIT);
    expect(await downloadPlugins([spec('vscode.git', GIT)], base, outDir)).toMatchObject({
      kept: ['vscode.git'],
    });
    expect(requests).toEqual([]);
  });

  it('replaces a local file whose hash does not match', async () => {
    await writeFile(join(outDir, 'vscode.git.vsix'), 'tampered');
    expect(await downloadPlugins([spec('vscode.git', GIT)], base, outDir)).toMatchObject({
      downloaded: ['vscode.git'],
    });
    expect(await readFile(join(outDir, 'vscode.git.vsix'))).toEqual(GIT);
  });

  it('removes anything that is not in the manifest', async () => {
    await writeFile(join(outDir, 'evil.extension.vsix'), 'x');
    await writeFile(join(outDir, '.leftover.download'), 'x');
    const result = await downloadPlugins([spec('vscode.git', GIT)], base, outDir);
    expect(result.removed.sort()).toEqual(['.leftover.download', 'evil.extension.vsix']);
    expect(await readdir(outDir)).toEqual(['vscode.git.vsix']);
  });

  it('fails on a hash mismatch and leaves no file behind', async () => {
    const pinned = { ...spec('vscode.git', GIT), sha256: sha256Of(Buffer.from('something else')) };
    await expect(downloadPlugins([pinned], base, outDir)).rejects.toThrow('does not match the pinned');
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

describe('lockPlugins', () => {
  it('returns the registry hash for each entry', async () => {
    const unlocked: PluginSpec[] = [{ id: 'vscode.git', version: '1.95.3', sha256: '' }];
    expect(await lockPlugins(unlocked, base)).toEqual([spec('vscode.git', GIT)]);
  });
});
