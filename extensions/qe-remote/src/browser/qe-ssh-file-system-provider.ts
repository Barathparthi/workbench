import type { FsListResult, FsReadResult, FsStat, FsWriteResult } from '@qe/contracts';
import { Disposable, Emitter, Event } from '@theia/core/lib/common';
import type URI from '@theia/core/lib/common/uri';
import {
  createFileSystemProviderError,
  FilePermission,
  FileSystemProviderErrorCode,
  FileType,
  type FileChange,
  type FileChangeType,
  type FileDeleteOptions,
  type FileOverwriteOptions,
  type FileSystemProviderCapabilities,
  type FileSystemProviderWithFileReadWriteCapability,
  type FileWriteOptions,
  type Stat,
} from '@theia/filesystem/lib/common/files';

import { RemoteApiError } from '../common/remote-client';
import { fromBase64, relativePath, toBase64, type RemoteFileSessions } from '../common/remote-files';

/* eslint-disable @typescript-eslint/no-unsafe-enum-assignment, @typescript-eslint/no-unnecessary-type-assertion --
   FileSystemProviderCapabilities and FileChangeType are ambient const enums (no runtime object), so their values are
   spelled out; FileType is a flag set (File | SymbolicLink), which TypeScript types as a plain number once combined. */
const CAPABILITIES = (2 | 1024) as FileSystemProviderCapabilities; // FileReadWrite | PathCaseSensitive
const UPDATED = 0 as FileChangeType;
const ADDED = 1 as FileChangeType;
const DELETED = 2 as FileChangeType;
const withLink = (type: FileType, link: boolean): FileType =>
  link ? ((type | FileType.SymbolicLink) as FileType) : type;
/* eslint-enable @typescript-eslint/no-unsafe-enum-assignment, @typescript-eslint/no-unnecessary-type-assertion */

/** API codes → Theia's provider errors, with messages the user can act on (never server detail). */
export function toProviderError(error: unknown): Error {
  if (!(error instanceof RemoteApiError)) {
    return createFileSystemProviderError(
      'The remote system cannot be reached.',
      FileSystemProviderErrorCode.Unavailable,
    );
  }
  const e = (message: string, code: FileSystemProviderErrorCode) =>
    createFileSystemProviderError(message, code);
  switch (error.code) {
    case 'NOT_FOUND':
      return e('No such file or folder on the remote system.', FileSystemProviderErrorCode.FileNotFound);
    case 'CONFLICT':
      return e('It already exists, or the folder is not empty.', FileSystemProviderErrorCode.FileExists);
    case 'REMOTE_FILE_TOO_LARGE':
      return e(
        'The file is larger than 10 MB, the limit for remote files.',
        FileSystemProviderErrorCode.FileTooLarge,
      );
    case 'PATH_OUTSIDE_ROOT':
      return e('That path leaves the remote folder.', FileSystemProviderErrorCode.NoPermissions);
    case 'FORBIDDEN':
      return e(
        'You may read files on this remote system, but not change them.',
        FileSystemProviderErrorCode.NoPermissions,
      );
    case 'REMOTE_FILE_CONFLICT':
      return e(
        'The file changed on the remote system since it was read. Reopen it and try again.',
        FileSystemProviderErrorCode.Unknown,
      );
    case 'TARGET_NOT_ALLOWED':
    case 'SESSION_REVOKED':
      return e(
        'Access to this remote system ended. Try again to reconnect.',
        FileSystemProviderErrorCode.NoPermissions,
      );
    case 'AUTH_REQUIRED':
      return e(
        'Your sign-in has expired. Reload the page to sign in again.',
        FileSystemProviderErrorCode.NoPermissions,
      );
    case 'SSH_TIMEOUT':
      return e('The remote system did not answer in time.', FileSystemProviderErrorCode.Unavailable);
    default:
      return e('The remote system cannot be reached.', FileSystemProviderErrorCode.Unavailable);
  }
}

function toStat(s: FsStat): Stat {
  // A link the server will not follow (it leaves the remote folder) is shown, read-only, as a file.
  const base =
    s.type === 'directory' ? FileType.Directory : s.type === 'other' ? FileType.Unknown : FileType.File;
  return {
    type: withLink(base, s.symlink),
    mtime: s.mtimeMs,
    ctime: s.mtimeMs,
    size: s.size,
    ...(s.type === 'symlink' && { permissions: FilePermission.Readonly }),
  };
}

/**
 * `qe-ssh://` in Theia (PHASE_09 §9.4, ADR-006 option B): every call goes from this page to the control plane's file
 * API, which reaches the target through the broker; nothing runs in the workspace runtime (P9). Writes carry the
 * ETag of the `stat` Theia makes just before writing (FileService.validateWriteFile), so a change on the server in
 * between is refused by the server too, not only by Theia's own "modified since" check.
 */
export class QeSshFileSystemProvider implements FileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = CAPABILITIES;
  readonly onDidChangeCapabilities = Event.None;
  protected readonly changes = new Emitter<readonly FileChange[]>();
  readonly onDidChangeFile = this.changes.event;
  readonly onFileWatchError = Event.None;
  /** ETag of the last stat, read or write of each file, by URI. */
  protected readonly etags = new Map<string, string>();

  constructor(protected readonly sessions: RemoteFileSessions) {}

  protected async call<T>(uri: URI, op: Parameters<RemoteFileSessions['call']>[1], body: object): Promise<T> {
    try {
      return await this.sessions.call<T>(uri.authority, op, body);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  watch(): Disposable {
    return Disposable.NULL; // polling watcher: P09.5
  }

  async stat(resource: URI): Promise<Stat> {
    try {
      const s = await this.call<FsStat>(resource, 'stat', { path: relativePath(resource.path.toString()) });
      this.etags.set(resource.toString(), s.etag);
      return toStat(s);
    } catch (error) {
      this.etags.delete(resource.toString());
      throw error;
    }
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const { entries } = await this.call<FsListResult>(resource, 'list', {
      path: relativePath(resource.path.toString()),
    });
    // Listings do not follow links; stat each link so the tree knows whether it is a folder.
    return Promise.all(
      entries.map(async (entry): Promise<[string, FileType]> => {
        if (entry.type === 'directory') return [entry.name, FileType.Directory];
        if (entry.type !== 'symlink')
          return [entry.name, entry.type === 'file' ? FileType.File : FileType.Unknown];
        const linked = await this.stat(resource.resolve(entry.name)).catch(() => undefined);
        return [entry.name, linked?.type ?? withLink(FileType.File, true)];
      }),
    );
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const r = await this.call<FsReadResult>(resource, 'read', {
      path: relativePath(resource.path.toString()),
    });
    this.etags.set(resource.toString(), r.etag);
    return fromBase64(r.contentBase64);
  }

  async writeFile(resource: URI, content: Uint8Array, options: FileWriteOptions): Promise<void> {
    const key = resource.toString();
    const ifMatch = options.overwrite ? this.etags.get(key) : undefined;
    const { etag } = await this.call<FsWriteResult>(resource, 'write', {
      path: relativePath(resource.path.toString()),
      contentBase64: toBase64(content),
      create: options.create,
      overwrite: options.overwrite,
      ...(ifMatch !== undefined && { ifMatch }),
    });
    const existed = ifMatch !== undefined;
    this.etags.set(key, etag);
    this.changes.fire([{ resource, type: existed ? UPDATED : ADDED }]);
  }

  async mkdir(resource: URI): Promise<void> {
    await this.call(resource, 'mkdir', { path: relativePath(resource.path.toString()) });
    this.changes.fire([{ resource, type: ADDED }]);
  }

  async delete(resource: URI, options: FileDeleteOptions): Promise<void> {
    await this.call(resource, 'delete', {
      path: relativePath(resource.path.toString()),
      recursive: options.recursive,
    });
    this.etags.delete(resource.toString());
    this.changes.fire([{ resource, type: DELETED }]);
  }

  async rename(from: URI, to: URI, options: FileOverwriteOptions): Promise<void> {
    if (from.authority !== to.authority) {
      throw createFileSystemProviderError(
        'Files cannot be moved between remote systems.',
        FileSystemProviderErrorCode.Unavailable,
      );
    }
    await this.call(from, 'rename', {
      from: relativePath(from.path.toString()),
      to: relativePath(to.path.toString()),
      overwrite: options.overwrite,
    });
    this.etags.delete(from.toString());
    this.changes.fire([
      { resource: from, type: DELETED },
      { resource: to, type: ADDED },
    ]);
  }
}
