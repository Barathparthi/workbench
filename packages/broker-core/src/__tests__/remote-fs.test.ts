import type ssh2 from 'ssh2';
import { beforeEach, describe, expect, it } from 'vitest';

import { REMOTE_FILE_LIMITS } from '@qe/contracts';
import { DomainError } from '@qe/domain';
import { FakeSftp } from '@qe/test-utils';

import {
  createRemoteFileSystem,
  etagOf,
  isTempName,
  mapSftpError,
  wrapSftp,
  type RemoteFileSystem,
  type RemoteFileSystemOptions,
} from '../index.js';

const ROOT = '/home/qe/work';
const SUFFIX = '0123456789abcdef';

let server: FakeSftp;
let fs: RemoteFileSystem;

function open(options: Partial<RemoteFileSystemOptions> = {}, fake = server): RemoteFileSystem {
  return createRemoteFileSystem(wrapSftp(fake as unknown as ssh2.SFTPWrapper), {
    remoteRoot: ROOT,
    canWrite: true,
    randomSuffix: () => SUFFIX,
    ...options,
  });
}

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'resolved';
}

const text = (s: string) => Buffer.from(s, 'utf8');

beforeEach(() => {
  server = new FakeSftp()
    .put(`${ROOT}/src/main.py`, 'print(1)\n')
    .put(`${ROOT}/README.md`, '# hi\n', 0o600)
    .put('/etc/passwd', 'root:x:0:0\n')
    .link(`${ROOT}/etc-link`, '/etc')
    .link(`${ROOT}/main-link`, 'src/main.py')
    .link(`${ROOT}/src-link`, 'src')
    .link(`${ROOT}/dangling`, 'nope');
  fs = open();
});

describe('stat', () => {
  it('describes a file with its permission bits and ETag', async () => {
    await expect(fs.stat({ path: 'src/main.py' })).resolves.toEqual({
      type: 'file',
      symlink: false,
      size: 9,
      mtimeMs: server.now * 1000,
      mode: 0o644,
      etag: `${String(server.now * 1000)}-9`,
    });
  });

  it('describes the root', async () => {
    await expect(fs.stat({ path: '' })).resolves.toMatchObject({ type: 'directory', symlink: false });
  });

  it('follows a link that stays inside the root', async () => {
    await expect(fs.stat({ path: 'main-link' })).resolves.toMatchObject({
      type: 'file',
      symlink: true,
      size: 9,
    });
  });

  it.each(['etc-link', 'dangling'])('shows %s as a link it will not follow', async (path) => {
    await expect(fs.stat({ path })).resolves.toMatchObject({ type: 'symlink', symlink: true });
  });

  it('reports a missing path as NOT_FOUND', async () => {
    expect(await codeOf(() => fs.stat({ path: 'nope.txt' }))).toBe('NOT_FOUND');
  });

  it('refuses traversal without asking the server', async () => {
    expect(await codeOf(() => fs.stat({ path: '../../../etc/passwd' }))).toBe('PATH_OUTSIDE_ROOT');
    expect(server.calls).toEqual([]);
  });

  it('refuses a path under a link that leaves the root', async () => {
    expect(await codeOf(() => fs.stat({ path: 'etc-link/passwd' }))).toBe('PATH_OUTSIDE_ROOT');
  });
});

describe('list', () => {
  it('lists directories first, then names; links are not followed; temp files are hidden', async () => {
    server.put(`${ROOT}/.main.py.qews-tmp-${SUFFIX}`, 'half');
    const result = await fs.list({ path: '' });
    expect(result.truncated).toBe(false);
    expect(result.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      'directory:src',
      'file:README.md',
      'symlink:dangling',
      'symlink:etc-link',
      'symlink:main-link',
      'symlink:src-link',
    ]);
  });

  it('stops at the limit and says so', async () => {
    const result = await fs.list({ path: '', limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('lists through a link that stays inside the root', async () => {
    const result = await fs.list({ path: 'src-link' });
    expect(result.entries.map((e) => e.name)).toEqual(['main.py']);
  });

  it('refuses a file and a link that leaves the root', async () => {
    expect(await codeOf(() => fs.list({ path: 'README.md' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(() => fs.list({ path: 'etc-link' }))).toBe('PATH_OUTSIDE_ROOT');
  });
});

describe('read', () => {
  it('returns the content and the same ETag as stat', async () => {
    const { data, etag } = await fs.read({ path: 'src/main.py' });
    expect(data.toString()).toBe('print(1)\n');
    expect(etag).toBe((await fs.stat({ path: 'src/main.py' })).etag);
  });

  it('reads through a link that stays inside the root', async () => {
    expect((await fs.read({ path: 'main-link' })).data.toString()).toBe('print(1)\n');
  });

  it('refuses a link that leaves the root', async () => {
    expect(await codeOf(() => fs.read({ path: 'etc-link/passwd' }))).toBe('PATH_OUTSIDE_ROOT');
  });

  it('refuses an 11 MB file with REMOTE_FILE_TOO_LARGE', async () => {
    server.put(`${ROOT}/big.bin`, Buffer.alloc(11 * 1024 * 1024));
    expect(await codeOf(() => fs.read({ path: 'big.bin' }))).toBe('REMOTE_FILE_TOO_LARGE');
  });

  it('reads a file of exactly the limit', async () => {
    server.put(`${ROOT}/edge.bin`, Buffer.alloc(REMOTE_FILE_LIMITS.maxFileBytes, 7));
    expect((await fs.read({ path: 'edge.bin' })).data.length).toBe(REMOTE_FILE_LIMITS.maxFileBytes);
  });

  it('honours a smaller maxBytes', async () => {
    expect(await codeOf(() => fs.read({ path: 'src/main.py', maxBytes: 8 }))).toBe('REMOTE_FILE_TOO_LARGE');
    expect((await fs.read({ path: 'src/main.py', maxBytes: 9 })).data.length).toBe(9);
  });

  it('refuses a directory and closes every handle', async () => {
    expect(await codeOf(() => fs.read({ path: 'src' }))).toBe('INVALID_REQUEST');
    expect(server.calls.filter((c) => c.startsWith('open')).length).toBe(
      server.calls.filter((c) => c === 'close').length,
    );
  });
});

describe('write', () => {
  it('creates a file atomically: temp file, then rename over the target', async () => {
    const { etag } = await fs.write({ path: 'src/new.py', data: text('x = 1\n') });
    expect(server.content(`${ROOT}/src/new.py`)).toBe('x = 1\n');
    expect(etag).toBe((await fs.stat({ path: 'src/new.py' })).etag);
    const temp = `${ROOT}/src/.new.py.qews-tmp-${SUFFIX}`;
    expect(server.calls).toContain(`open ${temp} wx`);
    expect(server.calls).toContain(`posix-rename ${temp} ${ROOT}/src/new.py`);
    expect(server.node(temp)).toBeUndefined();
    expect(server.node(`${ROOT}/src/new.py`)).toMatchObject({ mode: 0o644 });
  });

  it('keeps the permission bits of the file it replaces', async () => {
    await fs.write({ path: 'README.md', data: text('# changed\n') });
    expect(server.node(`${ROOT}/README.md`)).toMatchObject({ kind: 'file', mode: 0o600 });
  });

  it('writes when ifMatch is the current ETag', async () => {
    const { etag } = await fs.read({ path: 'src/main.py' });
    server.now += 5;
    const result = await fs.write({ path: 'src/main.py', data: text('print(2)\n!'), ifMatch: etag });
    expect(result.etag).toBe(`${String(server.now * 1000)}-10`);
  });

  it('refuses with REMOTE_FILE_CONFLICT when the file changed on the server since it was read', async () => {
    const { etag } = await fs.read({ path: 'src/main.py' });
    server.now += 1;
    server.put(`${ROOT}/src/main.py`, 'print("side channel")\n');
    expect(await codeOf(() => fs.write({ path: 'src/main.py', data: text('mine\n'), ifMatch: etag }))).toBe(
      'REMOTE_FILE_CONFLICT',
    );
    expect(server.content(`${ROOT}/src/main.py`)).toBe('print("side channel")\n');
    expect(server.paths().some((p) => isTempName(p.split('/').pop() ?? ''))).toBe(false);
  });

  it('known limitation: a same-second edit of equal size keeps the ETag (whole-second SFTP mtimes)', async () => {
    const { etag } = await fs.read({ path: 'src/main.py' });
    server.put(`${ROOT}/src/main.py`, 'print(9)\n');
    await expect(
      fs.write({ path: 'src/main.py', data: text('mine\n'), ifMatch: etag }),
    ).resolves.toBeDefined();
  });

  it('refuses ifMatch for a file that does not exist', async () => {
    expect(await codeOf(() => fs.write({ path: 'gone.py', data: text(''), ifMatch: '1-1' }))).toBe(
      'REMOTE_FILE_CONFLICT',
    );
  });

  it('honours create and overwrite', async () => {
    expect(await codeOf(() => fs.write({ path: 'new.py', data: text(''), create: false }))).toBe('NOT_FOUND');
    expect(await codeOf(() => fs.write({ path: 'README.md', data: text(''), overwrite: false }))).toBe(
      'CONFLICT',
    );
    await fs.write({ path: 'fresh.py', data: text('1'), overwrite: false });
    expect(server.calls).toContain(`rename ${ROOT}/.fresh.py.qews-tmp-${SUFFIX} ${ROOT}/fresh.py`);
  });

  it('refuses to write over a directory', async () => {
    expect(await codeOf(() => fs.write({ path: 'src', data: text('') }))).toBe('INVALID_REQUEST');
  });

  it('writes the file a link points to when it stays inside the root, and keeps the link', async () => {
    await fs.write({ path: 'main-link', data: text('via link\n') });
    expect(server.content(`${ROOT}/src/main.py`)).toBe('via link\n');
    expect(server.node(`${ROOT}/main-link`)).toMatchObject({ kind: 'symlink' });
  });

  it.each(['etc-link/passwd', 'etc-link'])('never writes outside the root through %s', async (path) => {
    expect(await codeOf(() => fs.write({ path, data: text('pwned') }))).toBe('PATH_OUTSIDE_ROOT');
    expect(server.content('/etc/passwd')).toBe('root:x:0:0\n');
  });

  it('refuses content over the limit before touching the server', async () => {
    const small = open({ limits: { maxFileBytes: 4 } });
    expect(await codeOf(() => small.write({ path: 'a', data: text('12345') }))).toBe('REMOTE_FILE_TOO_LARGE');
    expect(server.calls).toEqual([]);
  });

  it('removes the temp file when the rename fails', async () => {
    server.failNext('posix-rename', 3);
    expect(await codeOf(() => fs.write({ path: 'src/main.py', data: text('x') }))).toBe('FORBIDDEN');
    expect(server.node(`${ROOT}/src/.main.py.qews-tmp-${SUFFIX}`)).toBeUndefined();
    expect(server.content(`${ROOT}/src/main.py`)).toBe('print(1)\n');
  });

  it('replaces a file on a server without posix-rename (unlink, then rename)', async () => {
    const plain = new FakeSftp({ posixRename: false }).put(`${ROOT}/a.txt`, 'old');
    await open({}, plain).write({ path: 'a.txt', data: text('new') });
    expect(plain.content(`${ROOT}/a.txt`)).toBe('new');
    expect(plain.calls).toContain(`unlink ${ROOT}/a.txt`);
    await open({}, plain).write({ path: 'b.txt', data: text('b') });
    expect(plain.content(`${ROOT}/b.txt`)).toBe('b');
  });

  it('reports a remote permission problem as FORBIDDEN', async () => {
    server.deny(`${ROOT}/src`);
    expect(await codeOf(() => fs.write({ path: 'src/x.py', data: text('') }))).toBe('FORBIDDEN');
  });
});

describe('mkdir', () => {
  it('creates one directory and refuses an existing one', async () => {
    await fs.mkdir({ path: 'docs' });
    expect(server.node(`${ROOT}/docs`)).toMatchObject({ kind: 'dir' });
    expect(await codeOf(() => fs.mkdir({ path: 'docs' }))).toBe('CONFLICT');
    expect(await codeOf(() => fs.mkdir({ path: 'a/b' }))).toBe('NOT_FOUND');
    expect(await codeOf(() => fs.mkdir({ path: '' }))).toBe('INVALID_REQUEST');
  });

  it('creates missing parents with recursive, through links that stay inside the root', async () => {
    await fs.mkdir({ path: 'a/b/c', recursive: true });
    await fs.mkdir({ path: 'a/b/c', recursive: true });
    await fs.mkdir({ path: 'src-link/pkg/sub', recursive: true });
    await fs.mkdir({ path: '', recursive: true });
    expect(server.node(`${ROOT}/a/b/c`)).toMatchObject({ kind: 'dir' });
    expect(server.node(`${ROOT}/src/pkg/sub`)).toMatchObject({ kind: 'dir' });
  });

  it('refuses a file in the way and a link that leaves the root', async () => {
    expect(await codeOf(() => fs.mkdir({ path: 'README.md/x', recursive: true }))).toBe('CONFLICT');
    expect(await codeOf(() => fs.mkdir({ path: 'main-link/x', recursive: true }))).toBe('CONFLICT');
    expect(await codeOf(() => fs.mkdir({ path: 'etc-link/x', recursive: true }))).toBe('PATH_OUTSIDE_ROOT');
    expect(server.node('/etc/x')).toBeUndefined();
  });
});

describe('rename', () => {
  it('moves a file and refuses to replace without overwrite', async () => {
    await fs.rename({ from: 'README.md', to: 'src/README.md' });
    expect(server.content(`${ROOT}/src/README.md`)).toBe('# hi\n');
    expect(await codeOf(() => fs.rename({ from: 'src/README.md', to: 'src/main.py' }))).toBe('CONFLICT');
    await fs.rename({ from: 'src/README.md', to: 'src/main.py', overwrite: true });
    expect(server.content(`${ROOT}/src/main.py`)).toBe('# hi\n');
  });

  it('renames a link, never what it points to', async () => {
    await fs.rename({ from: 'etc-link', to: 'etc-link-2' });
    expect(server.node(`${ROOT}/etc-link-2`)).toMatchObject({ kind: 'symlink', target: '/etc' });
    expect(server.node('/etc')).toMatchObject({ kind: 'dir' });
  });

  it('refuses the impossible and the escaping', async () => {
    expect(await codeOf(() => fs.rename({ from: 'nope', to: 'x' }))).toBe('NOT_FOUND');
    expect(await codeOf(() => fs.rename({ from: 'src', to: 'src/inner' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(() => fs.rename({ from: 'README.md', to: 'etc-link/README.md' }))).toBe(
      'PATH_OUTSIDE_ROOT',
    );
    expect(await codeOf(() => fs.rename({ from: 'README.md', to: '../out.md' }))).toBe('PATH_OUTSIDE_ROOT');
    expect(await codeOf(() => fs.rename({ from: '', to: 'x' }))).toBe('INVALID_REQUEST');
  });

  it('is a no-op onto itself', async () => {
    await fs.rename({ from: 'README.md', to: './README.md' });
    expect(server.calls.some((c) => c.startsWith('rename') || c.startsWith('posix-rename'))).toBe(false);
  });
});

describe('delete', () => {
  it('deletes a file, and a link without touching its target', async () => {
    await fs.delete({ path: 'README.md' });
    await fs.delete({ path: 'etc-link' });
    expect(server.node(`${ROOT}/README.md`)).toBeUndefined();
    expect(server.node(`${ROOT}/etc-link`)).toBeUndefined();
    expect(server.content('/etc/passwd')).toBe('root:x:0:0\n');
  });

  it('deletes an empty directory and refuses a full one without recursive', async () => {
    server.mkdirp(`${ROOT}/empty`);
    await fs.delete({ path: 'empty' });
    expect(server.node(`${ROOT}/empty`)).toBeUndefined();
    expect(await codeOf(() => fs.delete({ path: 'src' }))).toBe('CONFLICT');
  });

  it('deletes a tree recursively without following links inside it', async () => {
    server
      .put(`${ROOT}/tree/a/b/c.txt`, 'c')
      .put(`${ROOT}/tree/d.txt`, 'd')
      .link(`${ROOT}/tree/a/out`, '/etc');
    await fs.delete({ path: 'tree', recursive: true });
    expect(server.paths().filter((p) => p.startsWith(`${ROOT}/tree`))).toEqual([]);
    expect(server.content('/etc/passwd')).toBe('root:x:0:0\n');
  });

  it('refuses a tree over the entry or depth cap before deleting anything', async () => {
    for (let i = 0; i < 5; i++) server.put(`${ROOT}/wide/f${String(i)}`, '');
    server.put(`${ROOT}/deep/1/2/3/4/f`, '');
    const capped = open({ limits: { maxDeleteEntries: 4, maxDeleteDepth: 3 } });
    expect(await codeOf(() => capped.delete({ path: 'wide', recursive: true }))).toBe('INVALID_REQUEST');
    expect(await codeOf(() => capped.delete({ path: 'deep', recursive: true }))).toBe('INVALID_REQUEST');
    expect(server.paths().filter((p) => p.startsWith(`${ROOT}/wide/`))).toHaveLength(5);
    expect(server.node(`${ROOT}/deep/1/2/3/4/f`)).toBeDefined();
  });

  it('refuses the root and anything outside it', async () => {
    expect(await codeOf(() => fs.delete({ path: '', recursive: true }))).toBe('INVALID_REQUEST');
    expect(await codeOf(() => fs.delete({ path: 'etc-link/passwd' }))).toBe('PATH_OUTSIDE_ROOT');
    expect(server.content('/etc/passwd')).toBe('root:x:0:0\n');
  });
});

describe('policy and limits', () => {
  it('refuses every change without file_write, before touching the server', async () => {
    const readOnly = open({ canWrite: false });
    const changes = [
      () => readOnly.write({ path: 'a', data: text('') }),
      () => readOnly.mkdir({ path: 'a' }),
      () => readOnly.rename({ from: 'README.md', to: 'b' }),
      () => readOnly.delete({ path: 'README.md' }),
    ];
    for (const change of changes) expect(await codeOf(change)).toBe('FORBIDDEN');
    expect(server.calls).toEqual([]);
    await expect(readOnly.read({ path: 'README.md' })).resolves.toBeDefined();
  });

  it('times an operation out with SSH_TIMEOUT', async () => {
    server.failNext('lstat', 'hang');
    const quick = open({ limits: { opTimeoutMs: 20 } });
    expect(await codeOf(() => quick.stat({ path: 'README.md' }))).toBe('SSH_TIMEOUT');
  });

  it('maps a lost channel and unsupported requests', async () => {
    server.failNext('stat', new Error('No response from server'));
    expect(await codeOf(() => fs.stat({ path: '' }))).toBe('SSH_UNREACHABLE');
    expect(mapSftpError(Object.assign(new Error('x'), { code: 8 })).code).toBe('INVALID_REQUEST');
    const own = new DomainError('NOT_FOUND');
    expect(mapSftpError(own)).toBe(own);
  });
});

describe('helpers', () => {
  it('builds ETags from whole milliseconds and size', () => {
    expect(etagOf({ mtimeMs: 1_761_000_000_000.7, size: 12 })).toBe('1761000000000-12');
  });

  it('recognizes only our temp names', () => {
    expect(isTempName(`.a.py.qews-tmp-${SUFFIX}`)).toBe(true);
    expect(isTempName('a.py.qews-tmp-0123456789abcdef')).toBe(false);
    expect(isTempName('.a.py.qews-tmp-xyz')).toBe(false);
  });

  it('closes the channel', () => {
    const channel = wrapSftp(server as unknown as ssh2.SFTPWrapper);
    let closed = false;
    channel.onClose(() => (closed = true));
    channel.close();
    expect(closed).toBe(true);
  });
});
