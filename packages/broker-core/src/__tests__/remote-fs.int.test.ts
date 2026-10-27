/**
 * Remote files against a real OpenSSH server (PHASE_09 §Tests): CRUD, atomic save, ETag conflict after a change on
 * the server, symlinks out of the root (planted, and swapped between calls), and the size limit. Needs Docker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DomainError } from '@qe/domain';
import { startOpenSsh, type OpenSshFixture } from '@qe/test-utils/openssh';

import {
  createHostKeyVerifier,
  createRemoteFileSystem,
  ssh2Transport,
  type RemoteFileSystem,
  type SftpChannel,
  type SshConnection,
} from '../index.js';

const ROOT = '/home/qe/work';

let server: OpenSshFixture;
let connection: SshConnection;
let sftp: SftpChannel;
let fs: RemoteFileSystem;

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

beforeAll(async () => {
  server = await startOpenSsh();
  connection = await ssh2Transport.connect(
    server.endpoint,
    { kind: 'key', privateKey: server.clientKey },
    createHostKeyVerifier([server.hostKey]),
  );
  sftp = await connection.sftp();
  fs = createRemoteFileSystem(sftp, { remoteRoot: ROOT, canWrite: true });
}, 240_000);

afterAll(async () => {
  sftp.close();
  connection.close();
  await server.stop();
});

beforeEach(async () => {
  await server.run(
    `rm -rf ${ROOT} /home/qe/outside && mkdir -p ${ROOT}/src /home/qe/outside && ` +
      `printf 'print(1)\\n' > ${ROOT}/src/main.py && printf 'canary\\n' > /home/qe/outside/passwd && ` +
      `ln -s /home/qe/outside ${ROOT}/out-link`,
  );
});

describe('remote files on OpenSSH', () => {
  it('creates, reads, lists, renames and deletes', async () => {
    const { etag } = await fs.write({ path: 'src/new.py', data: text('x = 1\n') });
    expect((await fs.read({ path: 'src/new.py' })).data.toString()).toBe('x = 1\n');
    expect((await fs.stat({ path: 'src/new.py' })).etag).toBe(etag);
    await fs.mkdir({ path: 'pkg/sub', recursive: true });
    await fs.rename({ from: 'src/new.py', to: 'pkg/sub/new.py' });
    const listing = await fs.list({ path: 'pkg/sub' });
    expect(listing.entries.map((e) => `${e.type}:${e.name}`)).toEqual(['file:new.py']);
    await fs.delete({ path: 'pkg', recursive: true });
    expect(await codeOf(() => fs.stat({ path: 'pkg' }))).toBe('NOT_FOUND');
    expect(await server.run(`ls -A ${ROOT}`)).not.toContain('pkg');
  });

  it('saves atomically, leaves no temp file and keeps the permission bits', async () => {
    await server.run(`chmod 600 ${ROOT}/src/main.py`);
    await fs.write({ path: 'src/main.py', data: text('print(2)\n') });
    expect(await server.run(`cat ${ROOT}/src/main.py`)).toBe('print(2)\n');
    expect(await server.run(`stat -c %a ${ROOT}/src/main.py`)).toBe('600\n');
    expect(await server.run(`ls -A ${ROOT}/src`)).toBe('main.py\n');
  });

  it('refuses a save with REMOTE_FILE_CONFLICT after a change on the server', async () => {
    const { etag } = await fs.read({ path: 'src/main.py' });
    await server.run(
      `printf 'side channel\\n' > ${ROOT}/src/main.py && touch -d '2023-01-01 00:00:00' ${ROOT}/src/main.py`,
    );
    expect(await codeOf(() => fs.write({ path: 'src/main.py', data: text('mine\n'), ifMatch: etag }))).toBe(
      'REMOTE_FILE_CONFLICT',
    );
    expect(await server.run(`cat ${ROOT}/src/main.py`)).toBe('side channel\n');
    const fresh = await fs.read({ path: 'src/main.py' });
    await fs.write({ path: 'src/main.py', data: text('mine\n'), ifMatch: fresh.etag });
    expect(await server.run(`cat ${ROOT}/src/main.py`)).toBe('mine\n');
  });

  it('denies a symlink out of the root, though the account could write there', async () => {
    expect(await codeOf(() => fs.read({ path: 'out-link/passwd' }))).toBe('PATH_OUTSIDE_ROOT');
    expect(await codeOf(() => fs.write({ path: 'out-link/passwd', data: text('pwned') }))).toBe(
      'PATH_OUTSIDE_ROOT',
    );
    expect(await codeOf(() => fs.list({ path: 'out-link' }))).toBe('PATH_OUTSIDE_ROOT');
    await expect(fs.stat({ path: 'out-link' })).resolves.toMatchObject({ type: 'symlink', symlink: true });
    await fs.delete({ path: 'out-link' });
    expect(await server.run('cat /home/qe/outside/passwd')).toBe('canary\n');
  });

  it('denies a directory swapped for a symlink between two calls', async () => {
    await server.run(`mkdir ${ROOT}/data && printf 'ok\\n' > ${ROOT}/data/passwd`);
    expect((await fs.read({ path: 'data/passwd' })).data.toString()).toBe('ok\n');
    await server.run(`rm -rf ${ROOT}/data && ln -s /home/qe/outside ${ROOT}/data`);
    expect(await codeOf(() => fs.read({ path: 'data/passwd' }))).toBe('PATH_OUTSIDE_ROOT');
    expect(await codeOf(() => fs.write({ path: 'data/passwd', data: text('pwned') }))).toBe(
      'PATH_OUTSIDE_ROOT',
    );
    expect(await server.run('cat /home/qe/outside/passwd')).toBe('canary\n');
  });

  it('refuses an 11 MB read with REMOTE_FILE_TOO_LARGE and reads a 10 MB file', async () => {
    await server.run(
      `head -c 11534336 /dev/zero > ${ROOT}/big.bin && head -c 10485760 /dev/zero > ${ROOT}/edge.bin`,
    );
    expect(await codeOf(() => fs.read({ path: 'big.bin' }))).toBe('REMOTE_FILE_TOO_LARGE');
    expect((await fs.read({ path: 'edge.bin' })).data.length).toBe(10_485_760);
  });

  it('writes a 10 MB file and reads it back intact', async () => {
    const data = Buffer.alloc(10 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 251;
    await fs.write({ path: 'blob.bin', data });
    expect((await fs.read({ path: 'blob.bin' })).data.equals(data)).toBe(true);
  });
});
