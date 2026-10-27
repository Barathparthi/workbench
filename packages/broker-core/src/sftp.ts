import { DomainError } from '@qe/domain';
import type ssh2 from 'ssh2';

/** What the server says about one path. `mode` keeps permission bits only. */
export interface RemoteStats {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

export interface RemoteDirEntry {
  readonly name: string;
  /** As the server lists it: a symlink is reported as `symlink`, never followed. */
  readonly stats: RemoteStats;
}

/**
 * The SFTP subsystem of one SSH connection, narrowed to what remote files need. Failures are DomainErrors:
 * NOT_FOUND, FORBIDDEN (remote permission), CONFLICT (the server refused the change: exists, not empty, …),
 * REMOTE_FILE_TOO_LARGE, INVALID_REQUEST, SSH_UNREACHABLE (the channel is gone).
 */
export interface SftpChannel {
  /** Canonical path. OpenSSH resolves every symlink and allows the last component not to exist. */
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<RemoteStats>;
  lstat(path: string): Promise<RemoteStats>;
  /** Up to `max` entries without `.` and `..`; `truncated` when the directory has more. */
  readdir(path: string, max: number): Promise<{ entries: RemoteDirEntry[]; truncated: boolean }>;
  /** A regular file of at most `maxBytes`; `stats` describe the handle that was read (no stat/read race). */
  readFile(path: string, maxBytes: number): Promise<{ data: Buffer; stats: RemoteStats }>;
  /** Creates a file that must not exist yet, with these permission bits, and writes `data`. */
  createFile(path: string, data: Uint8Array, mode: number): Promise<void>;
  /** With `replace`, an existing `to` is replaced atomically (`posix-rename@openssh.com`). */
  rename(from: string, to: string, replace: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  close(): void;
  onClose(listener: () => void): void;
}

/** SFTP v3 status codes (draft-ietf-secsh-filexfer-02 §7). */
const STATUS = {
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  OP_UNSUPPORTED: 8,
};

/** Maps an ssh2 SFTP failure to the API vocabulary. Messages are fixed: never the path or server text. */
export function mapSftpError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  switch (code) {
    case STATUS.NO_SUCH_FILE:
      return new DomainError('NOT_FOUND', 'no such remote file or directory');
    case STATUS.PERMISSION_DENIED:
      return new DomainError('FORBIDDEN', 'the remote system denied access', {
        details: { reason: 'remote_permission_denied' },
      });
    case STATUS.FAILURE:
      return new DomainError('CONFLICT', 'the remote system refused the change', {
        details: { reason: 'remote_failure' },
      });
    case STATUS.BAD_MESSAGE:
    case STATUS.OP_UNSUPPORTED:
      return new DomainError('INVALID_REQUEST', 'the remote system does not support this request');
    default:
      // No SFTP status: the channel or connection failed.
      return new DomainError('SSH_UNREACHABLE', 'the remote file channel is unavailable', { cause: error });
  }
}

function toStats(s: ssh2.Stats): RemoteStats {
  const kind = s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'other';
  return {
    kind,
    size: s.size,
    // SFTP v3 carries whole seconds; servers may omit the attribute.
    mtimeMs: (Number.isFinite(s.mtime) ? s.mtime : 0) * 1000,
    mode: s.mode & 0o7777,
  };
}

/** Reads and writes go out in pieces this size; ssh2 splits further to the server's packet limit. */
const CHUNK = 256 * 1024;

/** `sftp` behind `SftpChannel`. Every handle opened here is closed on every path out. */
export function wrapSftp(sftp: ssh2.SFTPWrapper): SftpChannel {
  const call = <T>(start: (done: (error: Error | null | undefined, value: T) => void) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      try {
        start((error, value) => {
          if (error) reject(mapSftpError(error));
          else resolve(value);
        });
      } catch (error) {
        reject(mapSftpError(error));
      }
    });
  const done = (start: (cb: ssh2.Callback) => void): Promise<void> =>
    call<undefined>((cb) => {
      start((error) => {
        cb(error, undefined);
      });
    });
  const closeHandle = (handle: Buffer): Promise<void> =>
    done((cb) => {
      sftp.close(handle, cb);
    }).catch(() => undefined);

  return {
    realpath: (path) =>
      call((cb) => {
        sftp.realpath(path, cb);
      }),
    stat: (path) =>
      call<ssh2.Stats>((cb) => {
        sftp.stat(path, cb);
      }).then(toStats),
    lstat: (path) =>
      call<ssh2.Stats>((cb) => {
        sftp.lstat(path, cb);
      }).then(toStats),

    async readdir(path, max) {
      const handle = await call<Buffer>((cb) => {
        sftp.opendir(path, cb);
      });
      const entries: RemoteDirEntry[] = [];
      try {
        for (;;) {
          const batch = await new Promise<ssh2.FileEntryWithStats[] | undefined>((resolve, reject) => {
            sftp.readdir(handle, (error, list) => {
              if ((error as { code?: unknown } | undefined)?.code === STATUS.EOF) resolve(undefined);
              else if (error) reject(mapSftpError(error));
              else resolve(list);
            });
          });
          if (batch === undefined) return { entries, truncated: false };
          for (const entry of batch) {
            if (entry.filename === '.' || entry.filename === '..') continue;
            if (entries.length === max) return { entries, truncated: true };
            entries.push({ name: entry.filename, stats: toStats(entry.attrs) });
          }
        }
      } finally {
        await closeHandle(handle);
      }
    },

    async readFile(path, maxBytes) {
      const handle = await call<Buffer>((cb) => {
        sftp.open(path, 'r', cb);
      });
      try {
        const stats = toStats(
          await call<ssh2.Stats>((cb) => {
            sftp.fstat(handle, cb);
          }),
        );
        if (stats.kind !== 'file') throw new DomainError('INVALID_REQUEST', 'not a regular file');
        if (stats.size > maxBytes) throw new DomainError('REMOTE_FILE_TOO_LARGE');
        // Read one byte past the limit: a file that grew since fstat is still refused, never truncated.
        const buffer = Buffer.alloc(Math.min(stats.size, maxBytes) + 1);
        let length = 0;
        while (length < buffer.length) {
          const n = await call<number>((cb) => {
            sftp.read(handle, buffer, length, Math.min(CHUNK, buffer.length - length), length, (e, bytes) => {
              cb(e, bytes);
            });
          });
          if (n === 0) break;
          length += n;
        }
        if (length > maxBytes) throw new DomainError('REMOTE_FILE_TOO_LARGE');
        return { data: buffer.subarray(0, length), stats: { ...stats, size: length } };
      } finally {
        await closeHandle(handle);
      }
    },

    async createFile(path, data, mode) {
      const handle = await call<Buffer>((cb) => {
        sftp.open(path, 'wx', { mode }, cb);
      });
      try {
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        for (let offset = 0; offset < buffer.length; offset += CHUNK) {
          const length = Math.min(CHUNK, buffer.length - offset);
          await done((cb) => {
            sftp.write(handle, buffer, offset, length, offset, cb);
          });
        }
      } finally {
        await closeHandle(handle);
      }
    },

    async rename(from, to, replace) {
      if (replace) {
        const atomic = await new Promise<boolean>((resolve, reject) => {
          try {
            sftp.ext_openssh_rename(from, to, (error) => {
              if (error) reject(mapSftpError(error));
              else resolve(true);
            });
          } catch {
            // ssh2 throws at once when the server did not offer posix-rename@openssh.com.
            resolve(false);
          }
        });
        if (atomic) return;
        // SFTP v3 rename refuses an existing target, so remove it first. Not atomic; only servers other than
        // OpenSSH get here.
        await done((cb) => {
          sftp.unlink(to, cb);
        }).catch((error: unknown) => {
          if (!(error instanceof DomainError && error.code === 'NOT_FOUND')) throw error;
        });
      }
      await done((cb) => {
        sftp.rename(from, to, cb);
      });
    },

    mkdir: (path) =>
      done((cb) => {
        sftp.mkdir(path, cb);
      }),
    rmdir: (path) =>
      done((cb) => {
        sftp.rmdir(path, cb);
      }),
    unlink: (path) =>
      done((cb) => {
        sftp.unlink(path, cb);
      }),
    close: () => {
      sftp.end();
    },
    onClose: (listener) => {
      sftp.on('close', listener);
    },
  };
}
