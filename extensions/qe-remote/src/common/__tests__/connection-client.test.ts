import { describe, expect, it, vi } from 'vitest';

import {
  compositeConnectionClient,
  EmbeddedConnection,
  hostedConnectionClient,
  isPersonalTarget,
  type ConnectionClient,
  type RemoteTarget,
  type TerminalSink,
} from '../connection-client';
import type { EmbeddedBrokerService } from '../embedded-broker-protocol';
import { RemoteApiError, type RemoteClient } from '../remote-client';
import type { RemoteFileSessions } from '../remote-files';

const personal: RemoteTarget = {
  id: 'personal-box',
  name: 'box',
  description: 'ada@box',
  detail: '',
  kind: 'personal',
};
const managed: RemoteTarget = {
  id: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f',
  name: 'lab-a-dev',
  description: '10.20.1.5',
  detail: '',
  kind: 'managed',
};

function sink() {
  const frames: (string | Uint8Array)[] = [];
  const closes: number[] = [];
  const s: TerminalSink = { frame: (f) => frames.push(f), closed: (c) => closes.push(c) };
  return { s, frames, closes };
}

function fakeService(over: Partial<EmbeddedBrokerService> = {}) {
  const service = {
    setClient: vi.fn(),
    dispose: vi.fn(),
    listTargets: vi.fn<EmbeddedBrokerService['listTargets']>(() =>
      Promise.resolve({
        targets: [
          { id: 'personal-box', name: 'box', host: 'box.lan', port: 22, user: 'ada', viaJumpHost: false },
          { id: 'personal-far', name: 'far', host: '10.0.0.9', port: 2222, user: 'ada', viaJumpHost: true },
        ],
        problems: ['odd: Port is not a port number'],
      }),
    ),
    openTerminal: vi.fn<EmbeddedBrokerService['openTerminal']>((id) =>
      Promise.resolve({ ok: true, value: id }),
    ),
    send: vi.fn<EmbeddedBrokerService['send']>(() => Promise.resolve()),
    closeTerminal: vi.fn<EmbeddedBrokerService['closeTerminal']>(() => Promise.resolve()),
    fs: vi.fn<EmbeddedBrokerService['fs']>(() => Promise.resolve({ ok: true, value: { etag: '1-1' } })),
    ...over,
  };
  return service;
}

describe('embedded connection (personal targets through the IDE backend)', () => {
  it('lists personal targets as user@host[:port], marking jump hosts', async () => {
    const conn = new EmbeddedConnection(() => fakeService());
    expect(await conn.listTargets()).toEqual({
      targets: [
        {
          id: 'personal-box',
          name: 'box',
          description: 'ada@box.lan',
          detail: 'from your SSH configuration',
          kind: 'personal',
        },
        {
          id: 'personal-far',
          name: 'far',
          description: 'ada@10.0.0.9:2222',
          detail: 'from your SSH configuration — via a jump host, not supported yet',
          kind: 'personal',
        },
      ],
      problems: ['odd: Port is not a port number'],
    });
  });

  it('registers the sink before the backend can send a frame, and routes frames and the close to it', async () => {
    const conn = new EmbeddedConnection(
      () => service,
      () => 'stream-1',
    );
    const service = fakeService({
      openTerminal: vi.fn<EmbeddedBrokerService['openTerminal']>((id) => {
        conn.client.onFrame(id, '{"t":"status","state":"CONNECTING"}'); // arrives before the reply
        return Promise.resolve({ ok: true, value: id });
      }),
    });
    const { s, frames, closes } = sink();
    const stream = await conn.openTerminal(personal, { cols: 80, rows: 24 }, s);
    conn.client.onFrame('stream-1', Uint8Array.of(1, 104, 105));
    conn.client.onFrame('other-stream', 'not mine');
    stream.send('{"t":"resize","cols":100,"rows":30}');
    stream.close();
    conn.client.onClosed('stream-1', 1000, 'client_closed');
    conn.client.onFrame('stream-1', 'after close');
    expect(frames).toEqual(['{"t":"status","state":"CONNECTING"}', Uint8Array.of(1, 104, 105)]);
    expect(closes).toEqual([1000]);
    expect(service.openTerminal).toHaveBeenCalledWith('stream-1', 'personal-box', { cols: 80, rows: 24 });
    expect(service.send).toHaveBeenCalledWith('stream-1', '{"t":"resize","cols":100,"rows":30}');
    expect(service.closeTerminal).toHaveBeenCalledWith('stream-1');
  });

  it('turns a refused open and a failed file operation into coded errors', async () => {
    const service = fakeService({
      openTerminal: () => Promise.resolve({ ok: false, code: 'NOT_FOUND' }),
      fs: () => Promise.resolve({ ok: false, code: 'PATH_OUTSIDE_ROOT' }),
    });
    const conn = new EmbeddedConnection(() => service);
    await expect(conn.openTerminal(personal, { cols: 80, rows: 24 }, sink().s)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(conn.call('personal-box', 'read', { path: '../x' })).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT',
    });
    expect(
      await new EmbeddedConnection(() => fakeService()).call('personal-box', 'stat', { path: '' }),
    ).toEqual({ etag: '1-1' });
  });

  it('asks for passphrases only through the asker the UI sets', async () => {
    const conn = new EmbeddedConnection(() => fakeService());
    expect(await conn.client.askPassphrase('box', 'id_ed25519')).toBeUndefined();
    conn.setPassphraseAsker((name, file) => Promise.resolve(`${name}/${file}`));
    expect(await conn.client.askPassphrase('box', 'id_ed25519')).toBe('box/id_ed25519');
  });
});

describe('composite connection client (managed + personal)', () => {
  const part = (kind: 'managed' | 'personal', over: Partial<ConnectionClient> = {}): ConnectionClient => ({
    listTargets: () => Promise.resolve({ targets: [kind === 'managed' ? managed : personal], problems: [] }),
    openTerminal: () => Promise.resolve({ send: () => undefined, close: () => undefined }),
    call: <T>() => Promise.resolve(kind as T),
    ...over,
  });

  it('lists both and routes each request to the part that owns its target', async () => {
    const both = compositeConnectionClient({ managed: part('managed'), personal: part('personal') });
    expect((await both.listTargets()).targets).toEqual([managed, personal]);
    expect(await both.call('personal-box', 'stat', { path: '' })).toBe('personal');
    expect(await both.call(managed.id, 'stat', { path: '' })).toBe('managed');
    expect(isPersonalTarget('personal-x')).toBe(true);
    expect(isPersonalTarget(managed.id)).toBe(false);
  });

  it('still lists one part when the other fails, and says so', async () => {
    const failing = part('managed', {
      listTargets: () => Promise.reject(new RemoteApiError(401, 'AUTH_REQUIRED')),
    });
    const mixed = compositeConnectionClient({ managed: failing, personal: part('personal') });
    expect(await mixed.listTargets()).toEqual({
      targets: [personal],
      problems: ['Some remote systems could not be listed.'],
    });
    const none = compositeConnectionClient({ managed: failing });
    await expect(none.listTargets()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('refuses a target whose part this mode does not have', async () => {
    const hostedOnly = compositeConnectionClient({ managed: part('managed') });
    await expect(hostedOnly.call('personal-box', 'stat', { path: '' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(hostedOnly.openTerminal(personal, { cols: 80, rows: 24 }, sink().s)).rejects.toBeInstanceOf(
      RemoteApiError,
    );
    expect((await compositeConnectionClient({}).listTargets()).targets).toEqual([]);
  });
});

describe('hosted connection client (control plane + broker WebSocket)', () => {
  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readyState = 0;
    binaryType = 'blob';
    sent: (string | Uint8Array)[] = [];
    closedWith: number | undefined;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {}
    send(frame: string | Uint8Array) {
      this.sent.push(frame);
    }
    close(code: number) {
      this.closedWith = code;
    }
  }

  it('queues frames until the socket opens, then streams both ways', async () => {
    let socket: FakeSocket | undefined;
    const client = {
      openTerminalSession: vi.fn(() =>
        Promise.resolve({ sessionId: 's', streamUrl: '/api/v1/sessions/s/stream', ticket: 'T'.repeat(43) }),
      ),
      listTargets: vi.fn(() =>
        Promise.resolve([
          {
            id: managed.id,
            name: 'lab-a-dev',
            host: '10.20.1.5',
            os: 'linux',
            tags: ['lab-a'],
            description: null,
          },
        ]),
      ),
    } as unknown as RemoteClient;
    const files = { call: vi.fn(() => Promise.resolve('file-result')) } as unknown as RemoteFileSessions;
    const hosted = hostedConnectionClient({
      client,
      files,
      origin: 'https://qe.example',
      createSocket: (url, protocols) => {
        socket = new FakeSocket(url, protocols);
        return socket as unknown as WebSocket;
      },
    });
    expect((await hosted.listTargets()).targets).toEqual([{ ...managed, detail: 'linux · lab-a' }]);
    const { s, frames, closes } = sink();
    const stream = await hosted.openTerminal(managed, { cols: 80, rows: 24 }, s);
    expect(socket?.url).toBe('wss://qe.example/api/v1/sessions/s/stream');
    stream.send('{"t":"resize","cols":90,"rows":30}');
    expect(socket?.sent).toEqual([]);
    if (socket === undefined) throw new Error('no socket');
    socket.readyState = 1;
    socket.onopen?.();
    expect(socket.sent).toEqual(['{"t":"resize","cols":90,"rows":30}']);
    socket.onmessage?.({ data: Uint8Array.of(1, 104).buffer });
    socket.onmessage?.({ data: '{"t":"status","state":"ACTIVE"}' });
    socket.onclose?.({ code: 4011 });
    expect(frames).toEqual([Uint8Array.of(1, 104), '{"t":"status","state":"ACTIVE"}']);
    expect(closes).toEqual([4011]);
    stream.close();
    expect(socket.closedWith).toBe(1000);
    expect(await hosted.call(managed.id, 'stat', { path: '' })).toBe('file-result');
  });
});
