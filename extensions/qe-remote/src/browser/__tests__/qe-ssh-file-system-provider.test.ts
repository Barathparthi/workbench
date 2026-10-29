import type { FsOp } from '@qe/contracts';
import URI from '@theia/core/lib/common/uri';
import { FilePermission, FileSystemProviderErrorCode, FileType } from '@theia/filesystem/lib/common/files';
import { describe, expect, it, vi } from 'vitest';

import { RemoteApiError } from '../../common/remote-client';
import type { RemoteFileSessions } from '../../common/remote-files';
import { QeSshFileSystemProvider, toProviderError } from '../qe-ssh-file-system-provider';

const TARGET = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const uri = (path: string) => new URI(`qe-ssh://${TARGET}/${path}`);
const fileStat = (over: object = {}) => ({
  type: 'file',
  symlink: false,
  size: 9,
  mtimeMs: 1_761_000_000_000,
  mode: 0o644,
  etag: '1761000000000-9',
  ...over,
});

function provider(answer: (op: FsOp, body: Record<string, unknown>) => unknown) {
  const calls: { target: string; op: FsOp; body: Record<string, unknown> }[] = [];
  const sessions = {
    call: vi.fn(async (target: string, op: FsOp, body: Record<string, unknown>) => {
      calls.push({ target, op, body });
      await Promise.resolve();
      return answer(op, body);
    }),
  } as unknown as RemoteFileSessions;
  return { p: new QeSshFileSystemProvider(sessions), calls };
}

describe('qe-ssh file system provider', () => {
  it('stats with the path relative to the remote folder', async () => {
    const { p, calls } = provider(() => fileStat());
    expect(await p.stat(uri('src/main.py'))).toEqual({
      type: FileType.File,
      mtime: 1_761_000_000_000,
      ctime: 1_761_000_000_000,
      size: 9,
    });
    expect(calls).toEqual([{ target: TARGET, op: 'stat', body: { path: 'src/main.py' } }]);
  });

  it('marks followed links and shows links it will not follow as read-only files', async () => {
    const followed = provider(() => fileStat({ type: 'directory', symlink: true }));
    expect((await followed.p.stat(uri('src-link'))).type).toBe(FileType.Directory | FileType.SymbolicLink);
    const outside = provider(() => fileStat({ type: 'symlink', symlink: true }));
    expect(await outside.p.stat(uri('etc-link'))).toMatchObject({
      type: FileType.File | FileType.SymbolicLink,
      permissions: FilePermission.Readonly,
    });
  });

  it('lists a folder, statting only the links', async () => {
    const { p, calls } = provider((op, body) =>
      op === 'list'
        ? {
            entries: [
              { name: 'src', type: 'directory', size: 0, mtimeMs: 0 },
              { name: 'a.py', type: 'file', size: 1, mtimeMs: 0 },
              { name: 'fifo', type: 'other', size: 0, mtimeMs: 0 },
              { name: 'src-link', type: 'symlink', size: 3, mtimeMs: 0 },
            ],
            truncated: false,
          }
        : body.path === 'src-link'
          ? fileStat({ type: 'directory', symlink: true })
          : fileStat(),
    );
    expect(await p.readdir(uri(''))).toEqual([
      ['src', FileType.Directory],
      ['a.py', FileType.File],
      ['fifo', FileType.Unknown],
      ['src-link', FileType.Directory | FileType.SymbolicLink],
    ]);
    expect(calls.map((c) => `${c.op}:${String(c.body.path)}`)).toEqual(['list:', 'stat:src-link']);
  });

  it('reads base64 content into bytes', async () => {
    const { p } = provider(() => ({ contentBase64: Buffer.from('hi\n').toString('base64'), etag: '1-3' }));
    expect(new TextDecoder().decode(await p.readFile(uri('a.txt')))).toBe('hi\n');
  });

  it('saves with the ETag of the stat Theia made just before, and reports the change', async () => {
    const { p, calls } = provider((op) => (op === 'stat' ? fileStat() : { etag: '1761000005000-5' }));
    const changes: unknown[] = [];
    p.onDidChangeFile((c) => changes.push(...c));
    await p.stat(uri('src/main.py'));
    await p.writeFile(uri('src/main.py'), new TextEncoder().encode('mine\n'), {
      create: true,
      overwrite: true,
    });
    expect(calls[1]).toEqual({
      target: TARGET,
      op: 'write',
      body: {
        path: 'src/main.py',
        contentBase64: Buffer.from('mine\n').toString('base64'),
        create: true,
        overwrite: true,
        ifMatch: '1761000000000-9',
      },
    });
    expect(changes).toHaveLength(1);
  });

  it('creates a new file without ifMatch', async () => {
    const { p, calls } = provider((op) => {
      if (op === 'stat') throw new RemoteApiError(404, 'NOT_FOUND');
      return { etag: '1-0' };
    });
    await expect(p.stat(uri('new.py'))).rejects.toMatchObject({
      code: FileSystemProviderErrorCode.FileNotFound,
    });
    await p.writeFile(uri('new.py'), new Uint8Array(), { create: true, overwrite: false });
    expect(calls[1]?.body).not.toHaveProperty('ifMatch');
  });

  it('passes mkdir, delete and rename through, and refuses moves between systems', async () => {
    const { p, calls } = provider(() => ({}));
    await p.mkdir(uri('docs'));
    await p.delete(uri('docs'), { recursive: true, useTrash: false });
    await p.rename(uri('a'), uri('b/a'), { overwrite: false });
    expect(calls.map((c) => [c.op, c.body])).toEqual([
      ['mkdir', { path: 'docs' }],
      ['delete', { path: 'docs', recursive: true }],
      ['rename', { from: 'a', to: 'b/a', overwrite: false }],
    ]);
    await expect(
      p.rename(uri('a'), new URI('qe-ssh://0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d00/a'), { overwrite: false }),
    ).rejects.toMatchObject({ code: FileSystemProviderErrorCode.Unavailable });
  });

  it.each([
    ['NOT_FOUND', FileSystemProviderErrorCode.FileNotFound],
    ['CONFLICT', FileSystemProviderErrorCode.FileExists],
    ['REMOTE_FILE_TOO_LARGE', FileSystemProviderErrorCode.FileTooLarge],
    ['PATH_OUTSIDE_ROOT', FileSystemProviderErrorCode.NoPermissions],
    ['FORBIDDEN', FileSystemProviderErrorCode.NoPermissions],
    ['SESSION_REVOKED', FileSystemProviderErrorCode.NoPermissions],
    ['AUTH_REQUIRED', FileSystemProviderErrorCode.NoPermissions],
    ['REMOTE_FILE_CONFLICT', FileSystemProviderErrorCode.Unknown],
    ['QUOTA_EXCEEDED', FileSystemProviderErrorCode.Unavailable],
    ['RATE_LIMITED', FileSystemProviderErrorCode.Unavailable],
    ['SSH_TIMEOUT', FileSystemProviderErrorCode.Unavailable],
    ['SSH_UNREACHABLE', FileSystemProviderErrorCode.Unavailable],
  ])('maps %s to a provider error the user can act on', (code, expected) => {
    const error = toProviderError(new RemoteApiError(400, code));
    expect(error).toMatchObject({ code: expected });
    expect(error.message).not.toMatch(/[A-Z_]{6,}/);
  });

  it('treats a network failure as unavailable', () => {
    expect(toProviderError(new TypeError('Failed to fetch'))).toMatchObject({
      code: FileSystemProviderErrorCode.Unavailable,
    });
  });
});

describe('qe-ssh watching', () => {
  it('reports a server-side change to a file the IDE read, through the polling watcher', async () => {
    vi.useFakeTimers();
    try {
      let etag = '1761000000000-9';
      const { p } = provider((op) => (op === 'read' ? { contentBase64: '', etag } : fileStat({ etag })));
      const changes: string[] = [];
      p.onDidChangeFile((c) =>
        changes.push(...c.map((x) => `${String(x.type)} ${x.resource.path.toString()}`)),
      );
      const watch = p.watch(uri(''), { recursive: true, excludes: [] });
      await p.readFile(uri('src/main.py'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changes).toEqual([]);
      etag = '1761000009000-14';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changes).toEqual(['0 /src/main.py']);
      watch.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('qe-ssh links out of the remote folder', () => {
  const refusing = (notices: string[], clock = { now: 0 }) => {
    const sessions = {
      call: vi.fn((_target: string, op: FsOp, body: Record<string, unknown>) => {
        if (op === 'list') {
          return Promise.resolve({
            entries: [{ name: 'escape', type: 'symlink', size: 0, mtimeMs: 0 }],
            truncated: false,
          });
        }
        return body['path'] === 'escape'
          ? Promise.reject(new RemoteApiError(403, 'PATH_OUTSIDE_ROOT'))
          : Promise.resolve(fileStat());
      }),
    } as unknown as RemoteFileSessions;
    return new QeSshFileSystemProvider(
      sessions,
      () => true,
      undefined,
      (message) => notices.push(message),
      () => clock.now,
    );
  };

  it('tells the user why a link out of the folder does not open, once per file per 10 s', async () => {
    const notices: string[] = [];
    const clock = { now: 0 };
    const p = refusing(notices, clock);
    await expect(p.stat(uri('escape'))).rejects.toMatchObject({
      code: FileSystemProviderErrorCode.NoPermissions,
    });
    await expect(p.readFile(uri('escape'))).rejects.toThrow();
    expect(notices).toEqual(['“escape” points outside the remote folder, so QE Workspace does not open it.']);
    clock.now = 11_000;
    await expect(p.stat(uri('escape'))).rejects.toThrow();
    expect(notices).toHaveLength(2);
  });

  it('says nothing while listing a folder that contains such a link', async () => {
    const notices: string[] = [];
    const p = refusing(notices);
    expect(await p.readdir(uri(''))).toEqual([['escape', FileType.File | FileType.SymbolicLink]]);
    expect(notices).toEqual([]);
  });
});
