import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ticketFromProtocols } from '@qe/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import type { StreamClient } from '../../common/managed-relay-protocol';
import { DesktopSignInError } from '../desktop-account';
import { ManagedRelay } from '../managed-relay';

const TARGET = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d10';
const SESSION = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d20';
const FILES_SESSION = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d30';

/** Control plane (REST) and broker (stream) on one local server. */
let server: Server;
let wss: WebSocketServer;
let base: string;
const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = [];
const upgrades: IncomingHttpHeaders[] = [];
let brokerSide: ServerSocket | undefined;
/** The token the control plane accepts (a refreshed one replaces it). */
let validToken = 'at-1';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      const send = (status: number, value: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (req.headers.authorization !== `Bearer ${validToken}`) return send(401, { code: 'AUTH_REQUIRED' });
      if (req.method === 'GET' && req.url === '/api/v1/targets') {
        return send(200, {
          items: [
            {
              id: TARGET,
              name: 'lab-a',
              host: 'qe-linux-01.lab',
              os: 'linux',
              tags: ['lab-a'],
              description: null,
            },
          ],
        });
      }
      if (req.method === 'POST' && req.url === `/api/v1/targets/${TARGET}/sessions`) {
        const kind = (JSON.parse(body) as { kind: string }).kind;
        return kind === 'files'
          ? send(201, { sessionId: FILES_SESSION })
          : send(201, {
              sessionId: SESSION,
              streamUrl: `/api/v1/sessions/${SESSION}/stream`,
              ticket: 'T'.repeat(43),
            });
      }
      if (req.method === 'POST' && req.url === `/api/v1/sessions/${FILES_SESSION}/fs/stat`) {
        return send(200, { type: 'file', size: 3, mtimeMs: 1, etag: '1-3', symlink: false });
      }
      return send(404, { code: 'NOT_FOUND' });
    });
  });
  wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('qews.v1') ? 'qews.v1' : false),
  });
  server.on('upgrade', (req, socket, head) => {
    upgrades.push(req.headers);
    wss.handleUpgrade(req, socket, head, (ws) => {
      brokerSide = ws;
      ws.send(JSON.stringify({ t: 'status', state: 'ACTIVE' }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  wss.close();
  server.close();
});
beforeEach(() => {
  requests.length = 0;
  upgrades.length = 0;
  validToken = 'at-1';
});

function relay(accessToken: () => Promise<string> = () => Promise.resolve(validToken)) {
  const frames: [string, string | Uint8Array][] = [];
  const closed: [string, number][] = [];
  const client: StreamClient = {
    onFrame: (id, frame) => frames.push([id, frame]),
    onClosed: (id, code) => closed.push([id, code]),
  };
  const r = new ManagedRelay({ controlPlaneUrl: `${base}/`, accessToken });
  r.setClient(client);
  return { r, frames, closed };
}

describe('desktop managed-target relay', () => {
  it('lists targets with the bearer token, and no cookie or CSRF header', async () => {
    const { r } = relay();
    expect(await r.listTargets()).toEqual({
      ok: true,
      value: [{ id: TARGET, name: 'lab-a', host: 'qe-linux-01.lab', detail: 'linux · lab-a' }],
    });
    const headers = requests[0]?.headers ?? {};
    expect(headers.authorization).toBe('Bearer at-1');
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-csrf-token']).toBeUndefined();
  });

  it('asks the account for a current token on every request', async () => {
    const { r } = relay(() => Promise.resolve(validToken));
    await r.listTargets();
    validToken = 'at-2'; // refreshed
    expect((await r.listTargets()).ok).toBe(true);
    expect(requests.map((q) => q.headers.authorization)).toEqual(['Bearer at-1', 'Bearer at-2']);
  });

  it('relays a terminal: ticket as a subprotocol, no Origin on the upgrade, frames both ways', async () => {
    const { r, frames, closed } = relay();
    const streamId = randomUUID();
    expect(await r.openTerminal(streamId, TARGET, { cols: 100, rows: 30 })).toEqual({
      ok: true,
      value: streamId,
    });
    await vi.waitFor(() => {
      expect(frames).toContainEqual([streamId, JSON.stringify({ t: 'status', state: 'ACTIVE' })]);
    });
    const upgrade = upgrades[0] ?? {};
    expect(upgrade.origin).toBeUndefined();
    // What the broker reads from the header (it accepts ws's 'a,b' as well as 'a, b').
    expect(ticketFromProtocols(upgrade['sec-websocket-protocol'])).toBe('T'.repeat(43));
    expect(upgrade.authorization).toBeUndefined(); // the ticket is the stream's only credential
    expect(JSON.parse(requests.find((q) => q.method === 'POST')?.body ?? '{}')).toEqual({
      kind: 'terminal',
      terminal: { cols: 100, rows: 30 },
    });

    const received = new Promise<Buffer>((resolve) =>
      brokerSide?.once('message', (d: Buffer) => {
        resolve(d);
      }),
    );
    await r.send(streamId, new Uint8Array([0x00, 0x6c, 0x73]));
    expect([...(await received)]).toEqual([0x00, 0x6c, 0x73]);

    await r.closeTerminal(streamId);
    await vi.waitFor(() => {
      expect(closed).toEqual([[streamId, 1000]]);
    });
  });

  it('runs file operations through a files-session, with the bearer token', async () => {
    const { r } = relay();
    expect(await r.fs(TARGET, 'stat', { path: 'notes.txt' })).toMatchObject({
      ok: true,
      value: { etag: '1-3' },
    });
    expect(requests.map((q) => `${q.method} ${q.path} ${q.headers.authorization ?? ''}`)).toEqual([
      `POST /api/v1/targets/${TARGET}/sessions Bearer at-1`,
      `POST /api/v1/sessions/${FILES_SESSION}/fs/stat Bearer at-1`,
    ]);
  });

  it('answers SIGN_IN_REQUIRED, without a request, when nobody is signed in', async () => {
    const { r } = relay(() =>
      Promise.reject(new DesktopSignInError('Sign in to QE Workspace first.', 'sign_in_required')),
    );
    expect(await r.listTargets()).toEqual({ ok: false, code: 'SIGN_IN_REQUIRED' });
    expect(await r.openTerminal(randomUUID(), TARGET, { cols: 80, rows: 24 })).toEqual({
      ok: false,
      code: 'SIGN_IN_REQUIRED',
    });
    expect(requests).toEqual([]);
  });

  it('answers SIGN_IN_REQUIRED when the control plane no longer accepts the token', async () => {
    const { r } = relay(() => Promise.resolve('at-revoked'));
    expect(await r.listTargets()).toEqual({ ok: false, code: 'SIGN_IN_REQUIRED' });
  });

  it.each([
    ['a stream id that is not a UUID', 'stream-1', TARGET],
    ['a personal target', randomUUID(), 'personal-lab'],
  ])('refuses %s', async (_label, streamId, targetId) => {
    const { r } = relay();
    expect(await r.openTerminal(streamId, targetId, { cols: 80, rows: 24 })).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
    expect(requests).toEqual([]);
  });

  it('refuses a stream id already in use', async () => {
    const { r } = relay();
    const streamId = randomUUID();
    expect((await r.openTerminal(streamId, TARGET, { cols: 80, rows: 24 })).ok).toBe(true);
    expect(await r.openTerminal(streamId, TARGET, { cols: 80, rows: 24 })).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
    r.dispose();
  });

  it('ends the window’s terminals when the window goes away', async () => {
    const { r, frames } = relay();
    const streamId = randomUUID();
    await r.openTerminal(streamId, TARGET, { cols: 80, rows: 24 });
    await vi.waitFor(() => {
      expect(frames.length).toBeGreaterThan(0);
    });
    const brokerClosed = new Promise<number>((resolve) =>
      brokerSide?.once('close', (code: number) => {
        resolve(code);
      }),
    );
    r.dispose();
    expect(await brokerClosed).toBe(1000);
  });
});
