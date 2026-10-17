/**
 * Built-in VS Code plugins for the IDE apps: pinned by version and SHA-256 in config/vscode-plugins.json,
 * downloaded from the Open VSX registry named by QE_VSX_URL (the internal mirror, ADR-010) and unpacked into
 * plugins/<id>/ (Theia deploys only unpacked system plugins).
 *
 *   QE_VSX_URL=https://openvsx.corp node scripts/plugins.ts download   # verify every hash, remove strays
 *   QE_VSX_URL=https://openvsx.corp node scripts/plugins.ts lock        # print hashes for the manifest
 *
 * Runs on Node 24 directly (type stripping): erasable TypeScript only, no runtime dependencies.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

export interface PluginSpec {
  /** `<namespace>.<name>` as on Open VSX. */
  readonly id: string;
  readonly version: string;
  /** Lower-case hex SHA-256 of the .vsix; empty only while locking a new entry. */
  readonly sha256: string;
}

export interface Limits {
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export const DEFAULT_LIMITS: Limits = { timeoutMs: 60_000, maxBytes: 100 * 1024 * 1024 };

const ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class PluginError extends Error {
  override readonly name = 'PluginError';
}

/** Validates the manifest; `allowMissingHashes` is only for `lock`. */
export function parseManifest(json: unknown, { allowMissingHashes = false } = {}): PluginSpec[] {
  const plugins = (json as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins) || plugins.length === 0)
    throw new PluginError('manifest: "plugins" must be a non-empty array');
  const seen = new Set<string>();
  return plugins.map((entry: unknown, index) => {
    const { id, version, sha256 } = (entry ?? {}) as Record<string, unknown>;
    const where = `manifest: plugins[${index}]`;
    if (typeof id !== 'string' || !ID.test(id))
      throw new PluginError(`${where}: id must be "<namespace>.<name>"`);
    if (typeof version !== 'string' || !VERSION.test(version))
      throw new PluginError(`${where} (${id}): version must be x.y.z`);
    const hash = typeof sha256 === 'string' ? sha256 : '';
    if (!SHA256.test(hash) && !(allowMissingHashes && hash === '')) {
      throw new PluginError(`${where} (${id}): sha256 must be 64 lower-case hex characters`);
    }
    if (seen.has(id.toLowerCase())) throw new PluginError(`${where}: duplicate id ${id}`);
    seen.add(id.toLowerCase());
    return { id, version, sha256: hash };
  });
}

/** The registry base URL: https, or plain http only on loopback (tests, local mirrors). */
export function registryBase(raw: string | undefined): URL {
  if (raw === undefined || raw === '')
    throw new PluginError('QE_VSX_URL is not set (URL of the Open VSX mirror)');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PluginError('QE_VSX_URL must be an absolute URL');
  }
  checkTransport(url, 'QE_VSX_URL');
  if (url.username !== '' || url.password !== '')
    throw new PluginError('QE_VSX_URL must not contain credentials');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function checkTransport(url: URL, what: string): void {
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) throw new PluginError(`${what} must use https`);
}

/** Open VSX file endpoint: `<base>api/<namespace>/<name>/<version>/file/<namespace>.<name>-<version>.vsix`. */
export function vsixUrl(base: URL, spec: PluginSpec): URL {
  const [namespace, name] = spec.id.split('.') as [string, string];
  return new URL(`api/${namespace}/${name}/${spec.version}/file/${spec.id}-${spec.version}.vsix`, base);
}

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const MAX_REDIRECTS = 5;

/**
 * GET with a deadline and a size cap. Redirects (Open VSX sends file downloads to blob storage) are
 * followed by hand so every hop is checked for https before it is requested.
 */
export async function fetchBytes(url: URL, limits: Limits = DEFAULT_LIMITS): Promise<Buffer> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const failed = (error: unknown) =>
    new PluginError(`GET ${url.href} failed: ${error instanceof Error ? error.message : String(error)}`);
  let current = url;
  let response: Response;
  for (let hop = 0; ; hop++) {
    checkTransport(current, hop === 0 ? `GET ${url.href}` : `redirect from ${url.href}`);
    response = await fetch(current, { signal, redirect: 'manual' }).catch((error: unknown) => {
      throw failed(error);
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) break;
    await response.body?.cancel();
    if (hop === MAX_REDIRECTS) throw new PluginError(`GET ${url.href}: more than ${MAX_REDIRECTS} redirects`);
    current = new URL(location, current);
  }
  if (!response.ok || response.body === null)
    throw new PluginError(`GET ${url.href} returned ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limits.maxBytes)
    throw new PluginError(`GET ${url.href}: ${declared} bytes exceeds ${limits.maxBytes}`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // Node's fetch types the body as ReadableStream<any>; it yields bytes.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        await reader.cancel();
        throw new PluginError(`GET ${url.href}: more than ${limits.maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    throw error instanceof PluginError ? error : failed(error);
  }
  return Buffer.concat(chunks);
}

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 20_000, maxTotalBytes: 500 * 1024 * 1024 };

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** A path inside an archive that is safe to create under the destination, or an error. */
function safeEntryPath(name: string): string {
  const bad =
    name === '' ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name) ||
    name.split('/').includes('..');
  if (bad) throw new PluginError(`archive entry "${name}" escapes the destination`);
  return posix.normalize(name);
}

/**
 * Extracts a ZIP (.vsix) held in memory: stored and deflated entries, CRC-checked. Refuses encrypted and
 * ZIP64 archives, symlinks, paths leaving `destDir`, and archives over the limits. Callers verify the
 * archive's SHA-256 first; these checks are defence in depth.
 */
export async function extractZip(
  zip: Buffer,
  destDir: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<number> {
  const corrupt = (why: string) => new PluginError(`invalid archive: ${why}`);
  // End of central directory record: 22 bytes plus a comment of up to 64 KiB, at the very end.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt('no end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw corrupt('ZIP64 is not supported');
  if (count > limits.maxEntries) throw corrupt(`more than ${limits.maxEntries} entries`);
  const root = resolve(destDir);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50)
      throw corrupt('bad central directory');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const crc = zip.readUInt32LE(offset + 16);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const mode = zip.readUInt32LE(offset + 38) >>> 16;
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if ((flags & 0x1) !== 0) throw corrupt(`"${name}" is encrypted`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw corrupt('ZIP64 is not supported');
    }
    if ((mode & S_IFMT) === S_IFLNK) throw corrupt(`"${name}" is a symbolic link`);
    const relative = safeEntryPath(name);
    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) throw corrupt(`"${name}" escapes the destination`);
    if (name.endsWith('/')) {
      await mkdir(target, { recursive: true });
      continue;
    }
    total += size;
    if (total > limits.maxTotalBytes) throw corrupt(`more than ${limits.maxTotalBytes} bytes when unpacked`);

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50)
      throw corrupt('bad local header');
    const dataStart =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) throw corrupt(`"${name}" is truncated`);
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) {
      try {
        content = inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw corrupt(`"${name}" does not inflate to its declared size`);
      }
    } else throw corrupt(`"${name}" uses unsupported compression method ${method}`);
    if (content.length !== size || crc32(content) !== crc) throw corrupt(`"${name}" fails its CRC check`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return count;
}

/** Records, inside each unpacked plugin, the archive hash it was unpacked from. */
const MARKER = '.qe-sha256';

/**
 * Makes `outDir` contain exactly the manifest's plugins, each unpacked from an archive whose SHA-256 matched
 * the pin. Plugins already unpacked from the pinned hash are kept; anything else in the folder is removed.
 * Unpacking goes to a dot-folder first (Theia ignores dotfiles) and is renamed into place when complete.
 */
export async function downloadPlugins(
  specs: readonly PluginSpec[],
  base: URL,
  outDir: string,
  limits: Limits = DEFAULT_LIMITS,
): Promise<{ downloaded: string[]; kept: string[]; removed: string[] }> {
  await mkdir(outDir, { recursive: true });
  const wanted = new Map(specs.map((s) => [s.id, s]));
  const removed: string[] = [];
  for (const entry of await readdir(outDir)) {
    if (!wanted.has(entry)) {
      await rm(join(outDir, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }
  const downloaded: string[] = [];
  const kept: string[] = [];
  for (const [id, spec] of wanted) {
    const target = join(outDir, id);
    const marker = await readFile(join(target, MARKER), 'utf8').catch(() => undefined);
    if (marker?.trim() === spec.sha256) {
      kept.push(id);
      continue;
    }
    const bytes = await fetchBytes(vsixUrl(base, spec), limits);
    const actual = sha256Of(bytes);
    if (actual !== spec.sha256) {
      throw new PluginError(
        `${id}@${spec.version}: sha256 ${actual} does not match the pinned ${spec.sha256}`,
      );
    }
    const temp = join(outDir, `.${id}.unpack`);
    await rm(temp, { recursive: true, force: true });
    try {
      await extractZip(bytes, temp);
      await writeFile(join(temp, MARKER), `${spec.sha256}\n`);
      await rm(target, { recursive: true, force: true });
      await rename(temp, target);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    downloaded.push(id);
  }
  return { downloaded, kept, removed };
}

/** Fetches every plugin once and returns the manifest entries with their current hashes. */
export async function lockPlugins(
  specs: readonly PluginSpec[],
  base: URL,
  limits: Limits = DEFAULT_LIMITS,
): Promise<PluginSpec[]> {
  const locked: PluginSpec[] = [];
  for (const spec of specs) {
    locked.push({ ...spec, sha256: sha256Of(await fetchBytes(vsixUrl(base, spec), limits)) });
  }
  return locked;
}

const repoRoot = resolve(import.meta.dirname, '..');
export const MANIFEST_PATH = join(repoRoot, 'config', 'vscode-plugins.json');
export const PLUGINS_DIR = join(repoRoot, 'plugins');

async function main(command: string | undefined): Promise<void> {
  const json: unknown = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const base = registryBase(process.env['QE_VSX_URL']);
  if (command === 'download') {
    const result = await downloadPlugins(parseManifest(json), base, PLUGINS_DIR);
    console.log(
      `plugins: ${result.downloaded.length} downloaded, ${result.kept.length} up to date, ${result.removed.length} removed (${base.origin})`,
    );
  } else if (command === 'lock') {
    const locked = await lockPlugins(parseManifest(json, { allowMissingHashes: true }), base);
    console.log(JSON.stringify(locked, null, 2));
  } else {
    throw new PluginError('usage: node scripts/plugins.ts download|lock');
  }
}

if (import.meta.filename === process.argv[1]) {
  main(process.argv[2]).catch((error: unknown) => {
    console.error(error instanceof PluginError ? `error: ${error.message}` : error);
    process.exitCode = 1;
  });
}
