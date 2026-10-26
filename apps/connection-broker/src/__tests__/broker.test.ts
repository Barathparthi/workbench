/**
 * Broker end to end, locally: a real WebSocket client → broker → ssh2 → an in-process SSH server (Phase 08 test
 * table). The control plane is faked; the SSRF guard sees lab addresses, and the test transport then dials the
 * loopback test server (loopback itself is — correctly — never allowed by the guard).
 */
import type { AddressInfo } from 'node:net';

import {
  createHostKeyVerifier,
  SessionRegistry,
  sha256Fingerprint,
  ssh2Transport,
  type SshTransport,
} from '@qe/broker-core';
import type { RedeemTicketResponse } from '@qe/contracts';
import { startSshServer, type TestSshServer } from '@qe/test-utils';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { ControlPlaneClient, StateReport } from '../control-plane-client.js';
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
let resolved: string[] = ['10.20.1.5'];
const reports: [string, StateReport][] = [];
const dialled: string[] = [];

const transport: SshTransport = {
  connect: (endpoint, credential, verifier, options) => {
    dialled.push(endpoint.address);
    return ssh2Transport.connect(
      { ...endpoint, address: '127.0.0.1', port: ssh.port },
      credential,
      verifier,
      options,
    );
  },
};
const controlPlane: ControlPlaneClient = {
  redeem: (ticket, origin) =>
    redeemError !== undefined
      ? Promise.reject(redeemError)
      : ticket === TICKET && origin === ORIGIN
        ? Promise.resolve(snapshot ?? freshSnapshot())
        : Promise.reject(new Error('bad ticket')),
  report: (id, r) => {
    reports.push([id, r]);
    return Promise.resolve();
  },
};
const registry = new SessionRegistry();
const state = { shuttingDown: false };

const freshSnapshot = (): RedeemTicketResponse => ({
  sessionId: SESSION,
  kind: 'terminal',
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

beforeAll(async () => {
  ssh = await startSshServer();
  app = await buildBroker({
    controlPlane,
    transport,
    credentials: { resolve: () => Promise.resolve({ kind: 'key', privateKey: ssh.clientKey }) },
    resolver: () => Promise.resolve(resolved),
    deniedCidrs: [],
    registry,
    instanceId: 'broker-test',
    allowedOrigins: [ORIGIN],
    internalToken: TOKEN,
    maxSessions: 10,
    state,
    log: { info: () => undefined, warn: () => undefined },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});
afterEach(() => {
  snapshot = freshSnapshot();
  redeemError = undefined;
  resolved = ['10.20.1.5'];
  reports.length = 0;
  dialled.length = 0;
  registry.closeAll('shutdown');
});
afterAll(async () => {
  await app.close();
  await ssh.close();
});

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
      {
        origin: opts.origin ?? ORIGIN,
      },
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
    ['no Origin', { origin: undefined as never }, 403],
    ['no ticket subprotocol', { protocols: ['qews.v1'] }, 401],
    ['a ticket without qews.v1', { protocols: [`ticket.${TICKET}`] }, 401],
    ['a ticket the control plane refuses', { protocols: ['qews.v1', `ticket.${'X'.repeat(43)}`] }, 401],
    ['a path outside the stream endpoint', { path: '/api/v1/sessions/nope/stream' }, 404],
  ])('refuses %s before any SSH connection', async (_label, opts, status) => {
    if (_label === 'no Origin') {
      // ws sends no Origin header unless one is given.
      const ws = new WebSocket(`${base}/api/v1/sessions/${SESSION}/stream`, ['qews.v1', `ticket.${TICKET}`]);
      const code = await new Promise<number>((r) =>
        ws.on('unexpected-response', (_q, res) => {
          r(res.statusCode ?? 0);
        }),
      );
      expect(code).toBe(403);
    } else {
      expect(await connect(opts)).toBe(status);
    }
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
