import { describe, expect, it, vi } from 'vitest';

import { RemoteApiError } from '../remote-client';
import {
  fromBase64,
  relativePath,
  remoteRootUri,
  RemoteFileSessions,
  toBase64,
  type FilesApi,
} from '../remote-files';

function fakeApi(answers: ((sessionId: string) => Promise<unknown>)[] = []) {
  let opened = 0;
  const api = {
    openFilesSession: vi.fn<FilesApi['openFilesSession']>(() =>
      Promise.resolve({ sessionId: `s${String(++opened)}` }),
    ),
    fileOp: vi.fn<FilesApi['fileOp']>((sessionId) =>
      (answers.shift() ?? (() => Promise.resolve('ok')))(sessionId),
    ),
    listSessions: vi.fn<FilesApi['listSessions']>(() => Promise.resolve([])),
  };
  return api;
}
const expired = () => Promise.reject(new RemoteApiError(410, 'SESSION_EXPIRED'));

/** sessionStorage in miniature. */
function fakeStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    get: (k: string) => items.get(k),
    set: (k: string, v: string) => void items.set(k, v),
    delete: (k: string) => void items.delete(k),
  };
}

describe('files-sessions across reloads', () => {
  const live = (over: object = {}) => ({
    id: 'old',
    kind: 'files',
    state: 'ACTIVE',
    targetId: 't1',
    ...over,
  });

  it('resumes the session the tab had before a reload, if it is still live', async () => {
    const api = fakeApi();
    api.listSessions.mockResolvedValue([live()]);
    const sessions = new RemoteFileSessions(api, fakeStore({ t1: 'old' }));
    await sessions.call('t1', 'stat', { path: '' });
    expect(api.openFilesSession).not.toHaveBeenCalled();
    expect(api.fileOp.mock.calls[0]?.[0]).toBe('old');
  });

  it.each([
    ['closed', live({ state: 'CLOSED' })],
    ['for another target', live({ targetId: 't2' })],
    ['a terminal', live({ kind: 'terminal' })],
  ])(
    'opens a new session when the remembered one is %s, and remembers the new one',
    async (_case, session) => {
      const api = fakeApi();
      api.listSessions.mockResolvedValue([session]);
      const store = fakeStore({ t1: 'old' });
      await new RemoteFileSessions(api, store).call('t1', 'stat', { path: '' });
      expect(api.fileOp.mock.calls[0]?.[0]).toBe('s1');
      expect(store.items.get('t1')).toBe('s1');
    },
  );

  it('opens a new session when the list cannot be read', async () => {
    const api = fakeApi();
    api.listSessions.mockRejectedValue(new RemoteApiError(503, 'INTERNAL_ERROR'));
    await new RemoteFileSessions(api, fakeStore({ t1: 'old' })).call('t1', 'stat', { path: '' });
    expect(api.fileOp.mock.calls[0]?.[0]).toBe('s1');
  });

  it('forgets a remembered session the server ended', async () => {
    const api = fakeApi([() => Promise.reject(new RemoteApiError(410, 'SESSION_REVOKED'))]);
    const store = fakeStore();
    await expect(new RemoteFileSessions(api, store).call('t1', 'stat', { path: '' })).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
    expect(store.items.has('t1')).toBe(false);
  });
});

describe('files-sessions in the IDE', () => {
  it('opens one session per target on first use and shares it', async () => {
    const api = fakeApi();
    const sessions = new RemoteFileSessions(api);
    await Promise.all([
      sessions.call('t1', 'stat', { path: '' }),
      sessions.call('t1', 'list', { path: '' }),
      sessions.call('t2', 'stat', { path: '' }),
    ]);
    expect(api.openFilesSession.mock.calls.map(([t]) => t)).toEqual(['t1', 't2']);
    expect(api.fileOp.mock.calls.map(([s, op]) => `${s}:${op}`)).toEqual(['s1:stat', 's1:list', 's2:stat']);
  });

  it('replaces a session the server closed (410) once, transparently', async () => {
    const api = fakeApi([expired]);
    const sessions = new RemoteFileSessions(api);
    expect(await sessions.call('t1', 'read', { path: 'a' })).toBe('ok');
    expect(api.fileOp.mock.calls.map(([s]) => s)).toEqual(['s1', 's2']);
  });

  it('gives up when the new session is refused too', async () => {
    const api = fakeApi([expired, expired]);
    const sessions = new RemoteFileSessions(api);
    await expect(sessions.call('t1', 'read', { path: 'a' })).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });

  it.each(['SESSION_REVOKED', 'TARGET_NOT_ALLOWED'])(
    'shows %s and opens a new session only on the next action',
    async (code) => {
      const api = fakeApi([() => Promise.reject(new RemoteApiError(410, code))]);
      const sessions = new RemoteFileSessions(api);
      await expect(sessions.call('t1', 'stat', { path: '' })).rejects.toMatchObject({ code });
      expect(api.openFilesSession).toHaveBeenCalledTimes(1);
      await sessions.call('t1', 'stat', { path: '' });
      expect(api.fileOp.mock.calls.map(([s]) => s)).toEqual(['s1', 's2']);
    },
  );

  it('keeps the session on ordinary file errors', async () => {
    const api = fakeApi([() => Promise.reject(new RemoteApiError(404, 'NOT_FOUND'))]);
    const sessions = new RemoteFileSessions(api);
    await expect(sessions.call('t1', 'stat', { path: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await sessions.call('t1', 'stat', { path: '' });
    expect(api.openFilesSession).toHaveBeenCalledTimes(1);
  });

  it('does not remember a session that could not be opened', async () => {
    const api = fakeApi();
    api.openFilesSession.mockRejectedValueOnce(new RemoteApiError(403, 'TARGET_NOT_ALLOWED'));
    const sessions = new RemoteFileSessions(api);
    await expect(sessions.call('t1', 'stat', { path: '' })).rejects.toMatchObject({
      code: 'TARGET_NOT_ALLOWED',
    });
    await sessions.call('t1', 'stat', { path: '' });
    expect(api.openFilesSession).toHaveBeenCalledTimes(2);
  });
});

describe('helpers', () => {
  it('builds root URIs and API paths', () => {
    expect(remoteRootUri('0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f')).toBe(
      'qe-ssh://0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f/',
    );
    expect(relativePath('/')).toBe('');
    expect(relativePath('')).toBe('');
    expect(relativePath('/src/main.py')).toBe('src/main.py');
  });

  it('round-trips bytes through base64 like Node does, also for large files', () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131) % 256;
    const encoded = toBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    // Buffer.equals: a deep toEqual over millions of elements is far too slow.
    expect(Buffer.from(fromBase64(encoded)).equals(Buffer.from(bytes))).toBe(true);
    expect(toBase64(new Uint8Array())).toBe('');
    expect(fromBase64('')).toEqual(new Uint8Array());
  });
});
