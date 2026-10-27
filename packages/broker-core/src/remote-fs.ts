import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

import {
  REMOTE_FILE_LIMITS,
  type FsDeleteRequest,
  type FsListRequest,
  type FsListResult,
  type FsMkdirRequest,
  type FsReadRequest,
  type FsRenameRequest,
  type FsStat,
  type FsStatRequest,
  type FsWriteResult,
} from '@qe/contracts';
import { DomainError } from '@qe/domain';

import { confine, createPathGuard, relativeToRoot } from './confine.js';
import type { RemoteStats, SftpChannel } from './sftp.js';

export interface FsWriteInput {
  readonly path: string;
  readonly data: Uint8Array;
  readonly ifMatch?: string | undefined;
  /** Default true. */
  readonly create?: boolean | undefined;
  /** Default true. */
  readonly overwrite?: boolean | undefined;
}

/** Remote file operations of one files-session (PHASE_09 §9.2). Contents are Buffers; the route encodes them. */
export interface RemoteFileSystem {
  stat(request: FsStatRequest): Promise<FsStat>;
  list(request: FsListRequest): Promise<FsListResult>;
  read(request: FsReadRequest): Promise<{ data: Buffer; etag: string }>;
  write(request: FsWriteInput): Promise<FsWriteResult>;
  mkdir(request: FsMkdirRequest): Promise<void>;
  rename(request: FsRenameRequest): Promise<void>;
  delete(request: FsDeleteRequest): Promise<void>;
}

export interface RemoteFileSystemOptions {
  readonly remoteRoot: string;
  /** The session's policy grants `file_write`; mutations are refused (FORBIDDEN) without it. */
  readonly canWrite: boolean;
  readonly limits?: Partial<Record<keyof typeof REMOTE_FILE_LIMITS, number>>;
  /** Temp-file suffix; tests make it predictable. */
  readonly randomSuffix?: () => string;
}

/** `${mtimeMs}-${size}` (PHASE_09 §9.2). */
export function etagOf(stats: Pick<RemoteStats, 'mtimeMs' | 'size'>): string {
  return `${String(Math.trunc(stats.mtimeMs))}-${String(stats.size)}`;
}

const TEMP_NAME = /^\..*\.qews-tmp-[0-9a-f]{16}$/;

/** Atomic saves write `.<name>.qews-tmp-<16 hex>` next to the file; listings hide such names. */
export function isTempName(name: string): boolean {
  return TEMP_NAME.test(name);
}

function notFound(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'NOT_FOUND';
}

async function maybe<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
}

function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DomainError('SSH_TIMEOUT', 'the remote file operation timed out'));
    }, ms);
  });
  return Promise.race([work(), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Every operation confines its paths again (lexically, then with the server's realpath): symlinks can change
 * between calls. Entries are created, renamed and deleted where the server resolved their parent, so the request
 * never goes through a symlink that leaves the root.
 *
 * Residual races (documented in the phase gate): the remote account can swap a directory for a symlink between
 * the check and the call, and an `ifMatch` write races another writer between the ETag check and the rename. The
 * account's own Unix permissions remain the hard limit; confinement keeps the IDE inside the policy's root.
 */
export function createRemoteFileSystem(
  sftp: SftpChannel,
  options: RemoteFileSystemOptions,
): RemoteFileSystem {
  const { remoteRoot } = options;
  const limits = { ...REMOTE_FILE_LIMITS, ...options.limits };
  const guard = createPathGuard(remoteRoot, (path) => sftp.realpath(path));
  const suffix = options.randomSuffix ?? (() => randomBytes(8).toString('hex'));
  const run = <T>(work: () => Promise<T>) => withTimeout(work, limits.opTimeoutMs);

  const requireWrite = () => {
    if (!options.canWrite) {
      throw new DomainError('FORBIDDEN', 'this connection policy does not allow changing remote files', {
        details: { capability: 'file_write' },
      });
    }
  };
  const isRoot = (path: string) => confine(remoteRoot, path) === remoteRoot;
  const toStat = (stats: RemoteStats, symlink: boolean): FsStat => ({
    type: stats.kind,
    symlink,
    size: stats.size,
    mtimeMs: Math.trunc(stats.mtimeMs),
    mode: stats.mode,
    etag: etagOf(stats),
  });

  async function stat(path: string): Promise<FsStat> {
    if (isRoot(path)) return toStat(await sftp.stat(await guard.resolve(path, 'follow')), false);
    const entry = await sftp.lstat(await guard.resolve(path, 'entry'));
    if (entry.kind !== 'symlink') return toStat(entry, false);
    try {
      return toStat(await sftp.stat(await guard.resolve(path, 'follow')), true);
    } catch (error) {
      // A link that leaves the root, or points nowhere, is shown as a link and never followed.
      if (notFound(error) || (error instanceof DomainError && error.code === 'PATH_OUTSIDE_ROOT')) {
        return toStat(entry, true);
      }
      throw error;
    }
  }

  async function list(path: string, limit: number): Promise<FsListResult> {
    const dir = await guard.resolve(path, 'follow');
    if ((await sftp.stat(dir)).kind !== 'directory')
      throw new DomainError('INVALID_REQUEST', 'not a directory');
    const { entries, truncated } = await sftp.readdir(dir, limit);
    return {
      entries: entries
        .filter((e) => !isTempName(e.name))
        .map((e) => ({
          name: e.name,
          type: e.stats.kind,
          size: e.stats.size,
          mtimeMs: Math.trunc(e.stats.mtimeMs),
        }))
        .sort((a, b) => {
          const dirs = Number(b.type === 'directory') - Number(a.type === 'directory');
          if (dirs !== 0) return dirs;
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        }),
      truncated,
    };
  }

  async function write(input: FsWriteInput): Promise<FsWriteResult> {
    requireWrite();
    if (input.data.byteLength > limits.maxFileBytes) throw new DomainError('REMOTE_FILE_TOO_LARGE');
    const create = input.create ?? true;
    const overwrite = input.overwrite ?? true;
    let target = await guard.resolve(input.path, 'entry');
    let current = await maybe(sftp.lstat(target));
    if (current?.kind === 'symlink') {
      // Saving a file opened through a link writes the file it points to, if that stays inside the root.
      target = await guard.resolve(input.path, 'follow');
      current = await maybe(sftp.stat(target));
    }
    if (current !== undefined) {
      if (current.kind !== 'file') throw new DomainError('INVALID_REQUEST', 'not a regular file');
      if (!overwrite)
        throw new DomainError('CONFLICT', 'the file already exists', { details: { reason: 'exists' } });
    } else if (!create) {
      throw new DomainError('NOT_FOUND', 'no such remote file or directory');
    }
    if (input.ifMatch !== undefined && (current === undefined || etagOf(current) !== input.ifMatch)) {
      throw new DomainError('REMOTE_FILE_CONFLICT', 'the remote file changed since it was read');
    }
    const name = posix.basename(target);
    const temp = posix.join(posix.dirname(target), `.${name.slice(0, 200)}.qews-tmp-${suffix()}`);
    // Keep the file's permissions, minus setuid/setgid: Linux drops them when anyone but root writes a file.
    await sftp.createFile(temp, input.data, current === undefined ? 0o644 : current.mode & ~0o6000);
    try {
      await sftp.rename(temp, target, overwrite);
    } catch (error) {
      await sftp.unlink(temp).catch(() => undefined);
      throw error;
    }
    return { etag: etagOf(await sftp.stat(target)) };
  }

  async function ensureDirectory(path: string): Promise<void> {
    const entry = await guard.resolve(path, 'entry');
    const existing = await maybe(sftp.lstat(entry));
    if (existing === undefined) {
      await sftp.mkdir(entry);
      return;
    }
    const kind =
      existing.kind === 'symlink'
        ? (await sftp.stat(await guard.resolve(path, 'follow'))).kind
        : existing.kind;
    if (kind !== 'directory')
      throw new DomainError('CONFLICT', 'a file is in the way', { details: { reason: 'exists' } });
  }

  async function mkdir(path: string, recursive: boolean): Promise<void> {
    requireWrite();
    if (!recursive) {
      const entry = await guard.resolve(path, 'entry');
      if ((await maybe(sftp.lstat(entry))) !== undefined) {
        throw new DomainError('CONFLICT', 'already exists', { details: { reason: 'exists' } });
      }
      await sftp.mkdir(entry);
      return;
    }
    const segments = relativeToRoot(remoteRoot, confine(remoteRoot, path)).split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i++) await ensureDirectory(segments.slice(0, i).join('/'));
  }

  async function rename(from: string, to: string, overwrite: boolean): Promise<void> {
    requireWrite();
    const source = await guard.resolve(from, 'entry');
    const destination = await guard.resolve(to, 'entry');
    await sftp.lstat(source);
    if (source === destination) return;
    if (destination.startsWith(`${source}/`)) {
      throw new DomainError('INVALID_REQUEST', 'cannot move a directory into itself');
    }
    const existing = await maybe(sftp.lstat(destination));
    if (existing !== undefined && !overwrite) {
      throw new DomainError('CONFLICT', 'the destination already exists', { details: { reason: 'exists' } });
    }
    await sftp.rename(source, destination, existing !== undefined);
  }

  interface Tree {
    readonly path: string;
    readonly leaves: string[];
    readonly dirs: Tree[];
  }

  /** Walks without following links; refuses before deleting anything if the tree is over the caps. */
  async function plan(path: string, depth: number, budget: { left: number }): Promise<Tree> {
    if (depth > limits.maxDeleteDepth) {
      throw new DomainError('INVALID_REQUEST', 'too deep to delete recursively', {
        details: { maxDepth: limits.maxDeleteDepth },
      });
    }
    const { entries, truncated } = await sftp.readdir(path, budget.left);
    budget.left -= entries.length;
    if (truncated) {
      throw new DomainError('INVALID_REQUEST', 'too many entries to delete recursively', {
        details: { maxEntries: limits.maxDeleteEntries },
      });
    }
    const tree: Tree = { path, leaves: [], dirs: [] };
    for (const entry of entries) {
      const child = posix.join(path, entry.name);
      if (entry.stats.kind === 'directory') tree.dirs.push(await plan(child, depth + 1, budget));
      else tree.leaves.push(child);
    }
    return tree;
  }

  async function removeTree(tree: Tree): Promise<void> {
    for (const dir of tree.dirs) await removeTree(dir);
    // The directory must still be where it was planned: a directory swapped for a symlink is not entered.
    if ((await sftp.realpath(tree.path)) !== tree.path) throw new DomainError('PATH_OUTSIDE_ROOT');
    for (let i = 0; i < tree.leaves.length; i += 16) {
      await Promise.all(tree.leaves.slice(i, i + 16).map((leaf) => sftp.unlink(leaf)));
    }
    await sftp.rmdir(tree.path);
  }

  async function deletePath(path: string, recursive: boolean): Promise<void> {
    requireWrite();
    const entry = await guard.resolve(path, 'entry');
    const stats = await sftp.lstat(entry);
    if (stats.kind !== 'directory') {
      await sftp.unlink(entry);
      return;
    }
    if (!recursive) {
      if ((await sftp.readdir(entry, 1)).entries.length > 0) {
        throw new DomainError('CONFLICT', 'the directory is not empty', { details: { reason: 'not_empty' } });
      }
      await sftp.rmdir(entry);
      return;
    }
    await removeTree(await plan(entry, 0, { left: limits.maxDeleteEntries }));
  }

  return {
    stat: (r) => run(() => stat(r.path)),
    list: (r) => run(() => list(r.path, Math.min(r.limit ?? limits.maxListEntries, limits.maxListEntries))),
    read: (r) =>
      run(async () => {
        const real = await guard.resolve(r.path, 'follow');
        const { data, stats } = await sftp.readFile(
          real,
          Math.min(r.maxBytes ?? limits.maxFileBytes, limits.maxFileBytes),
        );
        return { data, etag: etagOf(stats) };
      }),
    write: (r) => run(() => write(r)),
    mkdir: (r) => run(() => mkdir(r.path, r.recursive ?? false)),
    rename: (r) => run(() => rename(r.from, r.to, r.overwrite ?? false)),
    delete: (r) => run(() => deletePath(r.path, r.recursive ?? false)),
  };
}
