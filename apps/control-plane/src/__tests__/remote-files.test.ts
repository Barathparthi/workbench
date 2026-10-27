/** The remote-file routes (Phase 09 §9.3): schemas, limits, headers and errors around the service. */
import { DomainError } from '@qe/domain';
import { makePrincipal } from '../auth.js';
import { describe, expect, it } from 'vitest';

import type { RemoteFileService } from '../remote-file-service.js';
import type { RemoteSessionService } from '../remote-session-service.js';
import { buildServer } from '../server.js';
import type { TargetService } from '../target-service.js';
import { fakeHealth, fakeWorkspaces, logSink, testConfig } from './fixtures.js';

const SESSION = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const labUser = makePrincipal({
  userId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70',
  username: 'bob',
  roles: ['lab.a.user'],
});
const unused = new Proxy({}, { get: () => () => Promise.reject(new Error('unused')) });

async function server(run: RemoteFileService['run']) {
  const calls: { op: string; body: unknown }[] = [];
  const log = logSink();
  const app = await buildServer(testConfig(), {
    workspaces: fakeWorkspaces(),
    health: fakeHealth(),
    devPrincipal: labUser,
    logStream: log.stream,
    remote: {
      targets: unused as TargetService,
      sessions: unused as RemoteSessionService,
      files: {
        run: (ctx, id, op, body) => {
          calls.push({ op, body });
          return run(ctx, id, op, body);
        },
      },
    },
  });
  const post = (op: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${SESSION}/fs/${op}`,
      headers: { origin: 'https://qe.example' },
      payload: payload as Record<string, unknown>,
    });
  return { post, calls, log };
}

describe('remote file routes', () => {
  it('passes a valid request to the service and returns its result, uncached', async () => {
    const { post, calls } = await server(() =>
      Promise.resolve({ type: 'file', symlink: false, size: 3, mtimeMs: 1000, mode: 0o644, etag: '1000-3' }),
    );
    const res = await post('stat', { path: 'src/a.py' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ type: 'file', etag: '1000-3' });
    expect(calls).toEqual([{ op: 'stat', body: { path: 'src/a.py' } }]);
  });

  it('validates each operation’s body before the service sees it', async () => {
    const { post, calls } = await server(() => Promise.resolve({}));
    expect((await post('write', { path: 'a', contentBase64: 'not base64!' })).statusCode).toBe(400);
    expect((await post('rename', { from: 'a' })).statusCode).toBe(400);
    expect((await post('list', { path: '', limit: 5001 })).statusCode).toBe(400);
    expect((await post('stat', { path: '', extra: 1 })).statusCode).toBe(400);
    expect((await post('chmod', { path: '' })).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it('accepts a 10 MB write (13.4 MB as base64) and refuses a larger body with 413', async () => {
    const { post, calls } = await server(() => Promise.resolve({ etag: '1-1' }));
    const tenMb = Buffer.alloc(10 * 1024 * 1024, 7).toString('base64');
    expect((await post('write', { path: 'big.bin', contentBase64: tenMb })).statusCode).toBe(200);
    const elevenMb = Buffer.alloc(11 * 1024 * 1024, 7).toString('base64');
    expect((await post('write', { path: 'big.bin', contentBase64: elevenMb })).statusCode).toBe(413);
    expect(calls).toHaveLength(1);
  });

  it('answers with the service’s problem, and keeps paths and contents out of the logs', async () => {
    const { post, log } = await server(() => Promise.reject(new DomainError('REMOTE_FILE_CONFLICT')));
    const content = Buffer.from('LOG-CANARY-CONTENT').toString('base64');
    const res = await post('write', { path: 'secret-dir/file.txt', contentBase64: content, ifMatch: '1-1' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'REMOTE_FILE_CONFLICT' });
    expect(log.text()).not.toContain(content);
    expect(log.text()).not.toContain('secret-dir');
  });

  it('refuses a caller without remote:file_read', async () => {
    const app = await buildServer(testConfig(), {
      workspaces: fakeWorkspaces(),
      health: fakeHealth(),
      devPrincipal: makePrincipal({ userId: labUser.userId, username: 'carol', roles: ['qe.user'] }),
      logStream: logSink().stream,
      remote: {
        targets: unused as TargetService,
        sessions: unused as RemoteSessionService,
        files: { run: () => Promise.reject(new Error('must not run')) },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${SESSION}/fs/read`,
      headers: { origin: 'https://qe.example' },
      payload: { path: 'a' },
    });
    expect(res.statusCode).toBe(403);
  });
});
