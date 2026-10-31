/**
 * Broker end to end, locally: a real WebSocket client → broker → ssh2 → an in-process SSH server (Phase 08 test
 * table). The control plane is faked; the SSRF guard sees lab addresses, and the test transport then dials the
 * loopback test server (loopback itself is — correctly — never allowed by the guard).
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import {
  createHostKeyVerifier,
  SessionRegistry,
  sha256Fingerprint,
  ssh2Transport,
  wrapSftp,
  type SshTransport,
} from '@qe/broker-core';
import { DESKTOP_TICKET_ORIGIN, type BrokerTestRunResult, type RedeemTicketResponse } from '@qe/contracts';
import { FakeSftp, startSshServer, type TestSshServer } from '@qe/test-utils';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { ControlPlaneClient, StateReport } from '../control-plane-client.js';
import { FilesSessions } from '../files-sessions.js';
import { buildBroker } from '../server.js';

const ORIGIN = 'https://qe.example';
const TOKEN = 'internal-service-token-for-broker-tests-0123';
const SESSION = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const TICKET = 'T'.repeat(43);

let ssh: TestSshServer;
let app: FastifyInstance;
let base: string;
let snapshot: RedeemTicketResponse | undefined;
let redeemError: Error | undefined;
/** What the control plane bound the ticket to: the IDE's Origin, or the desktop marker for a bearer-token session. */
let ticketOrigin = ORIGIN;
let resolved: string[] = ['10.20.1.5'];
const reports: [string, StateReport][] = [];
/** Remote test run results reported to the control plane, and the order of every report (runs before sessions). */
const runReports: [string, BrokerTestRunResult][] = [];
const reportOrder: string[] = [];
const dialled: string[] = [];

/** The remote file system behind files-sessions (the in-process SSH server has no SFTP subsystem). */
let remoteFiles = new FakeSftp();
const transport: SshTransport = {
  connect: async (endpoint, credential, verifier, options) => {
    dialled.push(endpoint.address);
    const connection = await ssh2Transport.connect(
      { ...endpoint, address: '127.0.0.1', port: ssh.port },
      credential,
      verifier,
      options,
    );
    const sftp = wrapSftp(remoteFiles as unknown as Parameters<typeof wrapSftp>[0]);
    return { ...connection, sftp: () => Promise.resolve(sftp) };
  },
};
const controlPlane: ControlPlaneClient = {
  redeem: (ticket, origin) =>
    redeemError !== undefined
      ? Promise.reject(redeemError)
      : ticket === TICKET && origin === ticketOrigin
        ? Promise.resolve(snapshot ?? freshSnapshot())
        : Promise.reject(new Error('bad ticket')),
  report: (id, r) => {
    reports.push([id, r]);
    reportOrder.push(`session:${r.state}`);
    return Promise.resolve();
  },
  reportRun: (id, r) => {
    runReports.push([id, r]);
    reportOrder.push(`run:${r.state}`);
    return Promise.resolve();
  },
  started: () => Promise.resolve({ closed: 0 }),
};
const registry = new SessionRegistry();
const state = { shuttingDown: false, starting: false };

const freshSnapshot = (): RedeemTicketResponse => ({
  sessionId: SESSION,
  kind: 'terminal',
  testRun: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  terminal: null,
  user: { id: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d71', username: 'bob' },
  target: {
    id: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d72',
    name: 'qe-linux-01',
    host: 'qe-linux-01.lab.corp',
    port: 22,
    os: 'linux',
    principal: 'bob',
    remoteRoot: '/home/bob',
    jumpHostId: null,
  },
  policy: {
    id: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d73',
    version: 1,
    allowedCidrs: ['10.20.0.0/16'],
    allowedPorts: [22],
    capabilities: ['terminal'],
    idleTimeoutSec: 1800,
    maxSessionSec: 3600,
  },
  hostKeys: [{ algorithm: 'ssh-ed25519', fingerprintSha256: sha256Fingerprint(ssh.hostKeyBlob) }],
  credential: { provider: 'file_dev', method: 'vault_key', providerPath: 'lab-a/id', metadata: {} },
});

let files: FilesSessions;

/** The target's side of a test run (the in-process server has no shell): what the run does, and a cancel. */
type ServerChannel = Parameters<NonNullable<NonNullable<Parameters<typeof startSshServer>[0]>['exec']>>[1];
const RUN = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d80';
const REPORT = readFileSync('packages/runner/src/__tests__/fixtures/pytest-sample.xml', 'utf8');
let targetRun: 'report' | 'wait' = 'report';
let waiting: ServerChannel | undefined;
function playTarget(command: string, channel: ServerChannel): void {
  if (command.includes('kill -')) {
    // The cancel: the waiting run ends as pytest does on SIGINT (interrupted, exit 2).
    waiting?.write('KeyboardInterrupt\n');
    waiting?.exit(2);
    waiting?.end();
    waiting = undefined;
    channel.exit(0);
    channel.end();
    return;
  }
  channel.write('collected 5 items\n');
  if (targetRun === 'wait') {
    waiting = channel;
    return;
  }
  remoteFiles.mkdirp(`/home/bob/.qe-runs/${RUN}`).put(`/home/bob/.qe-runs/${RUN}/junit.xml`, REPORT);
  channel.write('1 failed, 3 passed, 1 skipped\n');
  channel.exit(1);
  channel.end();
}

const execSnapshot = (over: Partial<RedeemTicketResponse> = {}): RedeemTicketResponse => {
  const base = freshSnapshot();
  return {
    ...base,
    kind: 'exec',
    testRun: {
      runId: RUN,
      framework: 'pytest',
      selector: { kind: 'file', path: 'tests/test_calculator.py' },
    },
    policy: { ...base.policy, capabilities: ['terminal', 'exec'] },
    ...over,
  };
};

beforeAll(async () => {
  ssh = await startSshServer({
    exec: (command, channel) => {
      playTarget(command, channel);
    },
  });
  const runner = {
    controlPlane,
    transport,
    credentials: { resolve: () => Promise.resolve({ kind: 'key' as const, privateKey: ssh.clientKey }) },
    resolver: () => Promise.resolve(resolved),
    deniedCidrs: [],
    registry,
    instanceId: 'broker-test',
    log: { info: () => undefined, warn: () => undefined },
  };
  files = new FilesSessions(runner);
  app = await buildBroker({
    ...runner,
    files,
    allowedOrigins: [ORIGIN],
    internalToken: TOKEN,
    maxSessions: 10,
    state,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});
afterEach(() => {
  // First, so its "shutdown" reports are cleared with the rest.
  files.closeAll('shutdown');
  snapshot = freshSnapshot();
  redeemError = undefined;
  ticketOrigin = ORIGIN;
  resolved = ['10.20.1.5'];
  reports.length = 0;
  runReports.length = 0;
  reportOrder.length = 0;
  targetRun = 'report';
  waiting = undefined;
  dialled.length = 0;
  registry.closeAll('shutdown');
  remoteFiles = new FakeSftp();
});
afterAll(async () => {
  await app.close();
  await ssh.close();
});

/** Connect as the desktop app does: without an Origin header. */
const NO_ORIGIN = '<none>';

interface Client {
  ws: WebSocket;
  controls: Record<string, unknown>[];
  output: () => string;
  closed: Promise<number>;
}

function connect(
  opts: { origin?: string; protocols?: string[]; path?: string } = {},
): Promise<Client | number> {
  snapshot ??= freshSnapshot();
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `${base}${opts.path ?? `/api/v1/sessions/${SESSION}/stream`}`,
      opts.protocols ?? ['qews.v1', `ticket.${TICKET}`],
      // ws sends no Origin header unless one is given.
      opts.origin === NO_ORIGIN ? {} : { origin: opts.origin ?? ORIGIN },
    );
    const controls: Record<string, unknown>[] = [];
    let out = '';
    const closed = new Promise<number>((r) =>
      ws.on('close', (code) => {
        r(code);
      }),
    );
    ws.on('message', (data, isBinary) => {
      const b = data as Buffer;
      if (isBinary) out += b.subarray(1).toString();
      else controls.push(JSON.parse(b.toString()) as Record<string, unknown>);
    });
    ws.on('open', () => {
      resolve({ ws, controls, output: () => out, closed });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
    });
    ws.on('error', () => undefined);
  });
}
const asClient = (c: Client | number): Client => {
  if (typeof c === 'number') throw new Error(`refused with ${String(c)}`);
  return c;
};
const send = (ws: WebSocket, text: string) => {
  ws.send(Buffer.concat([Buffer.from([0x00]), Buffer.from(text)]));
};

describe('remote terminal through the broker', () => {
  it('opens the remote PTY at the size the IDE asked for when it opened the session', async () => {
    snapshot = { ...freshSnapshot(), terminal: { cols: 100, rows: 30 } };
    const c = asClient(await connect());
    await vi.waitFor(() => {
      expect(c.controls).toContainEqual({ t: 'status', state: 'ACTIVE' });
    });
    expect(ssh.events).toContain('pty:100x30:xterm-256color');
    c.ws.close();
    await c.closed;
    // The end report is asynchronous; let it land before the next test resets `reports`.
    await vi.waitFor(() => {
      expect(reports.map(([, r]) => r.state)).toEqual(['ACTIVE', 'CLOSED']);
    });
  });

  it('opens a pinned SSH session to the checked address and streams a working terminal', async () => {
    const c = asClient(await connect());
    expect(c.ws.protocol).toBe('qews.v1');
    await vi.waitFor(() => {
      expect(c.controls).toContainEqual({ t: 'status', state: 'ACTIVE' });
    });
    expect(c.controls[0]).toEqual({ t: 'status', state: 'CONNECTING' });
    expect(c.controls).toContainEqual(
      expect.objectContaining({ t: 'hostkey', algorithm: 'ssh-ed25519', verified: true }),
    );
    expect(dialled).toEqual(['10.20.1.5']);
    await vi.waitFor(() => {
      expect(c.output()).toContain('ready$');
    });
    send(c.ws, 'hello\r');
    await vi.waitFor(() => {
      expect(c.output()).toContain('echo:hello');
    });
    c.ws.send(JSON.stringify({ t: 'resize', cols: 132, rows: 43 }));
    await vi.waitFor(() => {
      expect(ssh.events).toContain('resize:132x43');
    });
    c.ws.send(JSON.stringify({ t: 'signal', signal: 'SIGINT' }));
    await vi.waitFor(() => {
      expect(ssh.events).toContain('ctrl-c');
    });
    send(c.ws, 'exit\r');
    expect(await c.closed).toBe(1000);
    expect(c.controls).toContainEqual({ t: 'exit', code: 0, signal: null });
    await vi.waitFor(() => {
      expect(reports.map(([, r]) => r.state)).toEqual(['ACTIVE', 'CLOSED']);
    });
    expect(reports[1]?.[1]).toMatchObject({
      reason: 'remote_exited',
      brokerInstance: 'broker-test',
      hostKey: { outcome: 'match' },
    });
  });

  it.each([
    ['a foreign Origin', { origin: 'https://evil.example' }, 403],
    // R17: an opaque origin (sandboxed frame, file:// page) and file:// itself are never the IDE.
    ['the null Origin', { origin: 'null' }, 403],
    ['a file:// Origin', { origin: 'file://' }, 403],
    // Without an Origin the ticket is redeemed as a desktop one; a browser ticket is bound to its Origin and fails.
    ['a browser ticket without its Origin', { origin: NO_ORIGIN }, 401],
    ['no ticket subprotocol', { protocols: ['qews.v1'] }, 401],
    ['a ticket without qews.v1', { protocols: [`ticket.${TICKET}`] }, 401],
    ['a ticket the control plane refuses', { protocols: ['qews.v1', `ticket.${'X'.repeat(43)}`] }, 401],
    ['a path outside the stream endpoint', { path: '/api/v1/sessions/nope/stream' }, 404],
  ])('refuses %s before any SSH connection', async (_label, opts, status) => {
    expect(await connect(opts)).toBe(status);
    expect(dialled).toEqual([]);
  });

  it('connects the desktop app, which sends no Origin, with a ticket bound to the desktop marker', async () => {
    ticketOrigin = DESKTOP_TICKET_ORIGIN;
    const c = asClient(await connect({ origin: NO_ORIGIN }));
    await vi.waitFor(() => {
      expect(c.controls).toContainEqual({ t: 'status', state: 'ACTIVE' });
    });
    c.ws.close();
    await c.closed;
    await vi.waitFor(() => {
      expect(reports).toHaveLength(2);
    });
  });

  it('refuses a desktop ticket presented by a browser, whose Origin it is not bound to', async () => {
    ticketOrigin = DESKTOP_TICKET_ORIGIN;
    expect(await connect()).toBe(401);
    expect(dialled).toEqual([]);
  });

  it('refuses a ticket for another session', async () => {
    snapshot = { ...freshSnapshot(), sessionId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d00' };
    expect(await connect()).toBe(401);
  });

  it('fails closed on a host-key mismatch and reports it', async () => {
    snapshot = {
      ...freshSnapshot(),
      hostKeys: [{ algorithm: 'ssh-ed25519', fingerprintSha256: `SHA256:${'Z'.repeat(43)}` }],
    };
    const c = asClient(await connect());
    expect(await c.closed).toBe(4500);
    expect(c.controls).toContainEqual(expect.objectContaining({ t: 'error', code: 'HOST_KEY_MISMATCH' }));
    await vi.waitFor(() => {
      expect(reports).toHaveLength(1);
    });
    expect(reports[0]?.[1]).toMatchObject({
      state: 'FAILED',
      reason: 'HOST_KEY_MISMATCH',
      hostKey: { outcome: 'mismatch' },
    });
  });

  it.each([
    [
      'the name now resolves to the metadata address (DNS changed since registration)',
      () => (resolved = ['169.254.169.254']),
      'TARGET_ADDRESS_FORBIDDEN',
    ],
    ['the address is outside the policy', () => (resolved = ['192.168.7.7']), 'TARGET_ADDRESS_FORBIDDEN'],
    [
      'the target needs a jump host',
      () => (snapshot = { ...freshSnapshot(), target: { ...freshSnapshot().target, jumpHostId: SESSION } }),
      'TARGET_NOT_ALLOWED',
    ],
    [
      'the port is not in the policy',
      () => (snapshot = { ...freshSnapshot(), target: { ...freshSnapshot().target, port: 2222 } }),
      'TARGET_NOT_ALLOWED',
    ],
    [
      'there is no credential',
      () => (snapshot = { ...freshSnapshot(), credential: null }),
      'CREDENTIALS_UNAVAILABLE',
    ],
  ])('refuses to dial when %s', async (_label, arrange, code) => {
    snapshot = freshSnapshot();
    resolved = ['10.20.1.5'];
    arrange();
    const c = asClient(await connect());
    expect(await c.closed).toBe(4500);
    expect(c.controls).toContainEqual(expect.objectContaining({ t: 'error', code }));
    expect(dialled).toEqual([]);
  });

  it('closes a session on internal revocation (service token only)', async () => {
    const c = asClient(await connect());
    await vi.waitFor(() => {
      expect(c.controls).toContainEqual({ t: 'status', state: 'ACTIVE' });
    });
    const http = base.replace('ws:', 'http:');
    const denied = await fetch(`${http}/internal/v1/sessions/${SESSION}/close`, { method: 'POST' });
    expect(denied.status).toBe(401);
    const wrong = await fetch(`${http}/internal/v1/sessions/${SESSION}/close`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${http}/internal/v1/sessions/${SESSION}/close`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await ok.json()).toEqual({ closed: true });
    expect(await c.closed).toBe(4011);
  });

  it('is not ready and opens no session until the control plane has acknowledged its start', async () => {
    const http = base.replace('ws:', 'http:');
    state.starting = true;
    try {
      expect(await (await fetch(`${http}/readyz`)).json()).toEqual({ status: 'starting' });
      expect(await connect()).toBe(503);
    } finally {
      state.starting = false;
    }
  });

  it('reports health and refuses new streams while draining', async () => {
    const http = base.replace('ws:', 'http:');
    expect(await (await fetch(`${http}/readyz`)).json()).toMatchObject({ status: 'ready' });
    state.shuttingDown = true;
    try {
      expect((await fetch(`${http}/readyz`)).status).toBe(503);
      expect(await connect()).toBe(503);
    } finally {
      state.shuttingDown = false;
    }
  });
});

describe('verifier sanity', () => {
  it('pins exactly the server’s key', () => {
    const v = createHostKeyVerifier([
      { algorithm: 'ssh-ed25519', fingerprintSha256: sha256Fingerprint(ssh.hostKeyBlob) },
    ]);
    expect(v.verify(ssh.hostKeyBlob)).toBe(true);
  });
});

describe('files-sessions (internal fs route)', () => {
  const http = () => base.replace('ws:', 'http:');
  const filesSnapshot = (overrides: Partial<RedeemTicketResponse['policy']> = {}): RedeemTicketResponse => {
    const s = freshSnapshot();
    return {
      ...s,
      kind: 'files',
      policy: { ...s.policy, capabilities: ['file_read', 'file_write'], ...overrides },
    };
  };
  const fsCall = async (
    op: string,
    request: unknown,
    snap: RedeemTicketResponse = filesSnapshot(),
    token = TOKEN,
    id = SESSION,
  ) => {
    const res = await fetch(`${http()}/internal/v1/sessions/${id}/fs/${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: snap, request }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('opens no files session until the control plane has acknowledged the broker’s start', async () => {
    state.starting = true;
    try {
      expect(await fsCall('stat', { path: '' })).toMatchObject({
        status: 502,
        body: { code: 'SSH_UNREACHABLE' },
      });
      expect(dialled).toEqual([]);
    } finally {
      state.starting = false;
    }
  });

  it('needs the service token', async () => {
    expect((await fsCall('stat', { path: '' }, filesSnapshot(), 'wrong-token-'.repeat(4))).status).toBe(401);
  });

  it('opens one SFTP connection on first use and reuses it; contents travel as base64', async () => {
    remoteFiles.mkdirp('/home/bob');
    expect(await fsCall('write', { path: 'notes.txt', contentBase64: b64('hello\n') })).toMatchObject({
      status: 200,
      body: { etag: expect.stringMatching(/^\d+-6$/) as unknown },
    });
    const read = await fsCall('read', { path: 'notes.txt' });
    expect(read.status).toBe(200);
    expect(Buffer.from(read.body.contentBase64 as string, 'base64').toString()).toBe('hello\n');
    expect(remoteFiles.content('/home/bob/notes.txt')).toBe('hello\n');
    expect(dialled).toEqual(['10.20.1.5']);
    expect(reports.filter(([, r]) => r.state === 'ACTIVE')).toHaveLength(1);
  });

  it('opens once under concurrent first calls', async () => {
    remoteFiles.mkdirp('/home/bob');
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => fsCall('stat', { path: '' })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(dialled).toHaveLength(1);
  });

  it('refuses changes without the policy’s file_write and paths outside the root', async () => {
    remoteFiles.mkdirp('/home/bob');
    const readOnly = filesSnapshot({ capabilities: ['file_read'] });
    expect(await fsCall('write', { path: 'a', contentBase64: b64('x') }, readOnly)).toMatchObject({
      status: 403,
      body: { code: 'FORBIDDEN' },
    });
    expect(await fsCall('read', { path: '../alice/secret' }, readOnly)).toMatchObject({
      status: 403,
      body: { code: 'PATH_OUTSIDE_ROOT' },
    });
  });

  it('refuses a snapshot for another session or kind, and malformed requests', async () => {
    const other = { ...filesSnapshot(), sessionId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d00' };
    expect((await fsCall('stat', { path: '' }, other)).status).toBe(400);
    expect((await fsCall('stat', { path: '' }, freshSnapshot())).status).toBe(400);
    expect(await fsCall('write', { path: 'a', contentBase64: 'not base64!' })).toMatchObject({
      status: 400,
      body: { code: 'INVALID_REQUEST' },
    });
    expect((await fsCall('chmod', { path: '' })).status).toBe(400);
    expect(dialled).toEqual([]);
  });

  it('runs the same pre-connect checks as terminals and reports the failure', async () => {
    resolved = ['169.254.169.254'];
    expect(await fsCall('stat', { path: '' })).toMatchObject({
      status: 403,
      body: { code: 'TARGET_ADDRESS_FORBIDDEN' },
    });
    expect(dialled).toEqual([]);
    expect(reports).toEqual([
      [SESSION, expect.objectContaining({ state: 'FAILED', reason: 'TARGET_ADDRESS_FORBIDDEN' })],
    ]);
  });

  it('closes on revocation and reports it', async () => {
    remoteFiles.mkdirp('/home/bob');
    await fsCall('stat', { path: '' });
    const res = await fetch(`${http()}/internal/v1/sessions/${SESSION}/close`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await res.json()).toEqual({ closed: true });
    expect(files.size).toBe(0);
    expect(remoteFiles.calls).toContain('end');
    expect(reports.at(-1)).toEqual([
      SESSION,
      expect.objectContaining({ state: 'CLOSED', reason: 'revoked' }),
    ]);
  });

  it('closes after the policy’s idle timeout', async () => {
    remoteFiles.mkdirp('/home/bob');
    await fsCall('stat', { path: '' }, filesSnapshot({ idleTimeoutSec: 1 }));
    await vi.waitFor(
      () => {
        expect(reports.at(-1)).toEqual([
          SESSION,
          expect.objectContaining({ state: 'CLOSED', reason: 'idle_timeout' }),
        ]);
      },
      { timeout: 3_000 },
    );
    expect(files.size).toBe(0);
  });

  it('does not close for idleness while an operation is still running', async () => {
    remoteFiles.mkdirp('/home/bob');
    const snapshot = filesSnapshot({ idleTimeoutSec: 1 });
    await fsCall('stat', { path: '' }, snapshot);
    remoteFiles.failNext('lstat', 'hang');
    const slow = fsCall('stat', { path: 'slow' }, snapshot);
    await new Promise((r) => setTimeout(r, 1_800));
    expect(reports.some(([, r]) => r.state === 'CLOSED')).toBe(false);
    expect(files.size).toBe(1);
    remoteFiles.releaseHung();
    expect((await slow).status).toBe(409);
  });
});

describe('remote test runs through the broker', () => {
  it('runs the session’s test run, streams it, and records the result before the session ends', async () => {
    snapshot = execSnapshot();
    const c = asClient(await connect());
    expect(await c.closed).toBe(1000);
    const command = ssh.events.find((e) => e.startsWith('exec:') && !e.includes('kill -')) ?? '';
    // Built by the broker from the run, every value quoted: never a client's text.
    expect(command).toContain(`cd -- '/home/bob' && mkdir -p -- '.qe-runs/${RUN}'`);
    expect(command).toContain("'python3' '-m' 'pytest'");
    expect(command).toContain("'tests/test_calculator.py'");
    expect(c.output()).toContain('1 failed, 3 passed, 1 skipped');
    expect(c.controls).toContainEqual(
      expect.objectContaining({
        t: 'run',
        result: expect.objectContaining({
          state: 'FAILED',
          exitCode: 1,
          counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 },
        }) as unknown,
      }),
    );
    await vi.waitFor(() => {
      expect(reportOrder).toEqual(['session:ACTIVE', 'run:FAILED', 'session:CLOSED']);
    });
    expect(runReports[0]?.[1]).toMatchObject({
      sessionId: SESSION,
      failures: [{ file: 'tests/test_calculator.py', line: 21 }],
      artifacts: [{ kind: 'junit_xml', path: `.qe-runs/${RUN}/junit.xml` }],
    });
  });

  it.each([
    [
      'the IDE’s Cancel',
      (c: Client) => {
        c.ws.send(JSON.stringify({ t: 'signal', signal: 'SIGINT' }));
      },
    ],
    [
      'the page going away',
      (c: Client) => {
        c.ws.close();
      },
    ],
  ])('stops the run on the target on %s, and records it CANCELLED', async (_label, stop) => {
    targetRun = 'wait';
    snapshot = execSnapshot();
    const c = asClient(await connect());
    await vi.waitFor(() => {
      expect(c.output()).toContain('collected 5 items');
    });
    stop(c);
    await vi.waitFor(() => {
      expect(ssh.events.some((e) => e.startsWith('exec:') && e.includes(`kill -INT`))).toBe(true);
    });
    await vi.waitFor(() => {
      expect(reportOrder).toEqual(['session:ACTIVE', 'run:CANCELLED', 'session:CLOSED']);
    });
    expect(runReports[0]?.[1]).toMatchObject({ state: 'CANCELLED', exitCode: 2 });
  });

  it.each([
    ['without a test run', (): Partial<RedeemTicketResponse> => ({ testRun: null })],
    [
      'under a policy without exec',
      (): Partial<RedeemTicketResponse> => ({
        policy: { ...freshSnapshot().policy, capabilities: ['terminal'] },
      }),
    ],
  ])('refuses an exec session %s, before any command runs', async (_label, over) => {
    const before = ssh.events.filter((e) => e.startsWith('exec:')).length;
    snapshot = execSnapshot(over());
    const c = asClient(await connect());
    await c.closed;
    expect(c.controls).toContainEqual(expect.objectContaining({ t: 'error', code: 'TARGET_NOT_ALLOWED' }));
    expect(ssh.events.filter((e) => e.startsWith('exec:')).length).toBe(before);
    expect(dialled).toEqual([]);
    await vi.waitFor(() => {
      expect(reports.map(([, r]) => r.state)).toEqual(['FAILED']);
    });
  });
});
