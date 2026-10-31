import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  DomainError,
  sha256Fingerprint,
  ssh2Transport,
  wrapSftp,
  type AuditSink,
  type HostKeyStore,
  type LocalAuditEvent,
  type NewPersonalHost,
  type PersonalTarget,
  type SshTransport,
} from '@qe/broker-core';
import { FakeSftp, startSshServer, type TestSshServer } from '@qe/test-utils';
import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  EmbeddedBrokerClient,
  HostKeyAnswer,
  HostKeyQuestion,
} from '../../common/embedded-broker-protocol';
import {
  describeUnexpected,
  EmbeddedBroker,
  personalMessage,
  type EmbeddedBrokerDeps,
} from '../embedded-broker';

const PASSPHRASE = 'correct horse';
/**
 * Waits for a state of a real SSH exchange with the test server. vi.waitFor gives up after 1 s by default, which a
 * sign-in with an encrypted key (bcrypt key derivation, a second connection) can exceed on a busy CI runner.
 */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 15_000, interval: 25 });
/** An encrypted key pair ssh2 can open with the passphrase. */
function encryptedKey(): { private: string; public: string } {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519', {
      passphrase: PASSPHRASE,
      cipher: 'aes256-ctr',
      rounds: 2,
    });
    if (!(ssh2.utils.parseKey(pair.private, PASSPHRASE) instanceof Error)) return pair;
  }
}

/** The host's side of a test run (the test server has no shell): the report it leaves, or a run that waits. */
const REPORT = readFileSync('packages/runner/src/__tests__/fixtures/pytest-sample.xml', 'utf8');
type ServerChannel = Parameters<NonNullable<NonNullable<Parameters<typeof startSshServer>[0]>['exec']>>[1];
let hostFiles = new FakeSftp({ home: '/home/ada' });
let hostRun: 'report' | 'wait' = 'report';
let waiting: ServerChannel | undefined;
function playHost(command: string, channel: ServerChannel): void {
  if (command.includes('kill -')) {
    waiting?.write('KeyboardInterrupt' + String.fromCharCode(10));
    waiting?.exit(2);
    waiting?.end();
    waiting = undefined;
    channel.exit(0);
    channel.end();
    return;
  }
  const runId = /\.qe-runs\/([0-9a-f-]{36})\//.exec(command)?.[1] ?? 'none';
  channel.write('collected 5 items' + String.fromCharCode(10));
  if (hostRun === 'wait') {
    waiting = channel;
    return;
  }
  hostFiles.mkdirp(`/home/ada/.qe-runs/${runId}`).put(`/home/ada/.qe-runs/${runId}/junit.xml`, REPORT);
  channel.exit(1);
  channel.end();
}

let plainServer: TestSshServer;
let lockedServer: TestSshServer;
const lockedKey = encryptedKey();

beforeAll(async () => {
  plainServer = await startSshServer({
    exec: (command, channel) => {
      playHost(command, channel);
    },
  });
  lockedServer = await startSshServer({ clientKey: lockedKey });
});
/** Every broker a test made is disposed afterwards, pass or fail, so no connection keeps the servers open. */
const brokers: EmbeddedBroker[] = [];
afterEach(() => {
  for (const b of brokers.splice(0)) b.dispose();
});
afterAll(async () => {
  await plainServer.close();
  await lockedServer.close();
});

const target = (server: TestSshServer, over: Partial<PersonalTarget> = {}): PersonalTarget => ({
  id: 'personal-box',
  alias: 'box',
  host: '127.0.0.1',
  port: server.port,
  user: 'ada',
  identityFiles: ['/keys/plain'],
  identitiesOnly: true,
  source: 'ssh-config',
  ...over,
});

interface Recorded {
  frames: (string | Uint8Array)[];
  closed: [number, string][];
  audit: LocalAuditEvent[];
  asked: string[];
  /** Host-key questions the user was asked. */
  questions: HostKeyQuestion[];
  /** Keys saved by "trust and save". */
  saved: Uint8Array[];
}

function setup(
  t: PersonalTarget,
  server: TestSshServer,
  over: Partial<EmbeddedBrokerDeps> & {
    /** false: nothing in known_hosts; 'other': a different key for this host. */
    trusted?: false | 'other';
    answer?: string;
    hostKeyAnswer?: () => Promise<HostKeyAnswer>;
  } = {},
) {
  const rec: Recorded = { frames: [], closed: [], audit: [], asked: [], questions: [], saved: [] };
  const hostKeys: HostKeyStore = {
    lookup: () =>
      Promise.resolve({
        trusted: [
          ...(over.trusted === undefined
            ? [{ algorithm: 'ssh-ed25519', fingerprintSha256: sha256Fingerprint(server.hostKeyBlob) }]
            : over.trusted === 'other'
              ? [{ algorithm: 'ssh-ed25519', fingerprintSha256: `SHA256:${'A'.repeat(43)}` }]
              : []),
          // "trust and save" is visible to later lookups, as with the real file
          ...rec.saved.map((k) => ({ algorithm: 'ssh-ed25519', fingerprintSha256: sha256Fingerprint(k) })),
        ],
        revoked: [],
      }),
    trust: (_host, _port, key) => {
      rec.saved.push(key);
      return Promise.resolve();
    },
  };
  const audit: AuditSink = {
    record: (e) => {
      rec.audit.push(e);
      return Promise.resolve();
    },
  };
  const keys: Record<string, Buffer> = {
    '/keys/plain': plainServer.clientKey,
    '/keys/locked': Buffer.from(lockedKey.private),
  };
  const broker = new EmbeddedBroker({
    targets: {
      list: () => Promise.resolve([t]),
      get: (id) => Promise.resolve(id.toLowerCase() === t.id ? t : undefined),
      problems: () => Promise.resolve(['bad-host: Port is not a port number']),
      add: () => Promise.reject(new Error('not used here')),
    },
    hostKeys,
    audit,
    transport: ssh2Transport,
    resolver: () => Promise.reject(new Error('IP literals only')),
    deniedCidrs: [],
    home: '/home/ada',
    agent: undefined,
    readKey: (path) => Promise.resolve(keys[path]),
    ...over,
  });
  const client: EmbeddedBrokerClient = {
    onFrame: (_id, frame) => rec.frames.push(frame),
    onClosed: (_id, code, reason) => rec.closed.push([code, reason]),
    askPassphrase: (name, file) => {
      rec.asked.push(`${name}:${file}`);
      return Promise.resolve(over.answer);
    },
    confirmHostKey: (question) => {
      rec.questions.push(question);
      return over.hostKeyAnswer?.() ?? Promise.resolve('cancel');
    },
  };
  broker.setClient(client);
  brokers.push(broker);
  const controls = () =>
    rec.frames
      .filter((f): f is string => typeof f === 'string')
      .map((f) => JSON.parse(f) as Record<string, unknown>);
  const output = () =>
    Buffer.concat(
      rec.frames.filter((f): f is Uint8Array => typeof f !== 'string').map((f) => Buffer.from(f.subarray(1))),
    ).toString();
  return { broker, rec, controls, output };
}

describe('embedded broker: terminals to personal targets', () => {
  it('lists personal targets without local detail, with the entries it could not use', async () => {
    const { broker } = setup(target(plainServer, { proxyJump: 'bastion' }), plainServer);
    expect(await broker.listTargets()).toEqual({
      targets: [
        {
          id: 'personal-box',
          name: 'box',
          host: '127.0.0.1',
          port: plainServer.port,
          user: 'ada',
          viaJumpHost: true,
        },
      ],
      problems: ['bad-host: Port is not a port number'],
    });
  });

  it('opens a terminal with the same qews.v1 frames as the hosted broker, then closes it', async () => {
    const { broker, rec, controls, output } = setup(target(plainServer), plainServer);
    const id = randomUUID();
    expect(await broker.openTerminal(id, 'PERSONAL-BOX', { cols: 100, rows: 30 })).toEqual({
      ok: true,
      value: id,
    });
    await eventually(() => {
      expect(controls().map((c) => c.state ?? c.t)).toEqual(['CONNECTING', 'hostkey', 'ACTIVE']);
    });
    expect(controls()[1]).toMatchObject({ algorithm: 'ssh-ed25519', verified: true });
    expect(plainServer.events).toContain('pty:100x30:xterm-256color');
    await broker.send(id, Uint8Array.of(0x00, ...Buffer.from('hello\r')));
    await eventually(() => {
      expect(output()).toContain('echo:hello');
    });
    await broker.closeTerminal(id);
    await eventually(() => {
      expect(rec.closed).toHaveLength(1);
    });
    expect(rec.audit.map((a) => a.action)).toEqual(['SSH_SESSION_OPENED', 'SSH_SESSION_CLOSED']);
  });

  it('asks for a passphrase only after the plain keys were rejected, then signs in with the unlocked key', async () => {
    const t = target(lockedServer, { identityFiles: ['/keys/plain', '/keys/locked'] });
    const { broker, rec, controls } = setup(t, lockedServer, { answer: PASSPHRASE });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(controls().map((c) => c.state ?? c.t)).toContain('ACTIVE');
    });
    expect(rec.asked).toEqual(['box:locked']);
    expect(rec.audit.map((a) => a.action)).toEqual(['SSH_SESSION_OPENED']);
  });

  it.each([
    ['an unknown host key', { trusted: false }, 'HOST_KEY_UNKNOWN'],
    [
      'a refused passphrase prompt',
      { identityFiles: ['/keys/locked'], server: 'locked' },
      'CREDENTIALS_UNAVAILABLE',
    ],
    ['a jump host', { proxyJump: 'bastion' }, 'TARGET_NOT_ALLOWED'],
    ['an address the organisation denies', { deniedCidrs: ['127.0.0.0/8'] }, 'TARGET_ADDRESS_FORBIDDEN'],
  ] as const)(
    'reports %s with the hosted broker’s message, and audits the failure',
    async (_case, c, code) => {
      const server = 'server' in c ? lockedServer : plainServer;
      const t = target(server, {
        ...('identityFiles' in c && { identityFiles: [...c.identityFiles] }),
        ...('proxyJump' in c && { proxyJump: c.proxyJump }),
      });
      const { broker, rec, controls } = setup(t, server, {
        ...('trusted' in c && { trusted: c.trusted }),
        ...('deniedCidrs' in c && { deniedCidrs: [...c.deniedCidrs] }),
      });
      await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
      await eventually(() => {
        expect(rec.closed).toHaveLength(1);
      });
      expect(controls().find((m) => m.t === 'error')).toMatchObject({
        code,
        message: expect.any(String) as unknown,
      });
      expect(rec.audit).toEqual([
        { action: 'SSH_CONNECT_FAILED', target: 'personal-box', outcome: 'failure', detail: { code } },
      ]);
    },
  );

  it('refuses a stream id that is not a UUID or already in use, and an unknown target', async () => {
    const { broker } = setup(target(plainServer), plainServer);
    expect(await broker.openTerminal('not-a-uuid', 'personal-box', { cols: 80, rows: 24 })).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
    expect(await broker.openTerminal(randomUUID(), 'personal-nope', { cols: 80, rows: 24 })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    const id = randomUUID();
    await broker.openTerminal(id, 'personal-box', { cols: 80, rows: 24 });
    expect(await broker.openTerminal(id, 'personal-box', { cols: 80, rows: 24 })).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
    broker.dispose();
  });

  it('ends every terminal when the window goes away', async () => {
    const { broker, rec, controls } = setup(target(plainServer), plainServer);
    await broker.openTerminal(randomUUID(), 'personal-box', { cols: 80, rows: 24 });
    await eventually(() => {
      expect(controls().map((c) => c.state ?? c.t)).toContain('ACTIVE');
    });
    broker.dispose();
    await eventually(() => {
      expect(rec.closed).toHaveLength(1);
    });
  });
});

describe('embedded broker: files on personal targets', () => {
  /** The real SSH connect, with the SFTP channel served by the in-memory fake (the test server has no SFTP). */
  function withFakeSftp(fake: FakeSftp): SshTransport {
    return {
      connect: async (endpoint, credential, verifier) => {
        const connection = await ssh2Transport.connect(endpoint, credential, verifier);
        const sftp = wrapSftp(fake as unknown as Parameters<typeof wrapSftp>[0]);
        return { ...connection, sftp: () => Promise.resolve(sftp) };
      },
    };
  }

  it('runs file operations in the remote home, with the same validation and errors as the hosted broker', async () => {
    const fake = new FakeSftp({ home: '/home/ada' })
      .put('/home/ada/notes.txt', 'hello\n')
      .put('/etc/passwd', 'x');
    const { broker, rec } = setup(target(plainServer), plainServer, { transport: withFakeSftp(fake) });
    const read = await broker.fs('personal-box', 'read', { path: 'notes.txt' });
    expect(read).toMatchObject({
      ok: true,
      value: { contentBase64: Buffer.from('hello\n').toString('base64') },
    });
    expect(
      await broker.fs('personal-box', 'write', {
        path: 'new.txt',
        contentBase64: Buffer.from('x').toString('base64'),
      }),
    ).toMatchObject({
      ok: true,
    });
    expect(fake.content('/home/ada/new.txt')).toBe('x');
    expect(await broker.fs('personal-box', 'read', { path: '../../etc/passwd' })).toEqual({
      ok: false,
      code: 'PATH_OUTSIDE_ROOT',
    });
    expect(await broker.fs('personal-box', 'write', { path: 'a', contentBase64: 'not base64!' })).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
    expect(await broker.fs('personal-nope', 'stat', { path: '' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(rec.audit.filter((a) => a.action === 'REMOTE_FILE_CHANGE')).toEqual([
      { action: 'REMOTE_FILE_CHANGE', target: 'personal-box', outcome: 'success', detail: { op: 'write' } },
    ]);
    broker.dispose();
    await eventually(() => {
      expect(fake.calls).toContain('end');
    });
  });

  it('closes an unused file connection after its idle time', async () => {
    const fake = new FakeSftp();
    const { broker } = setup(target(plainServer), plainServer, {
      transport: withFakeSftp(fake),
      filesIdleMs: 50,
    });
    await broker.fs('personal-box', 'stat', { path: '' });
    await eventually(() => {
      expect(fake.calls).toContain('end');
    });
  });
});

describe('embedded broker: host keys of personal targets (trust on first use)', () => {
  const states = (controls: () => Record<string, unknown>[]) => controls().map((c) => c.state ?? c.t);
  const fingerprint = () => sha256Fingerprint(plainServer.hostKeyBlob);

  it('asks about an unknown host key, connects after "trust once", and does not ask again in this window', async () => {
    const t = target(plainServer);
    const { broker, rec, controls } = setup(t, plainServer, {
      trusted: false,
      hostKeyAnswer: () => Promise.resolve('once'),
    });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(states(controls)).toContain('ACTIVE');
    });
    expect(rec.questions).toEqual([
      {
        targetName: 'box',
        host: '127.0.0.1',
        port: plainServer.port,
        algorithm: 'ssh-ed25519',
        fingerprintSha256: fingerprint(),
      },
    ]);
    expect(rec.saved).toEqual([]);
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(states(controls).filter((s) => s === 'ACTIVE')).toHaveLength(2);
    });
    expect(rec.questions).toHaveLength(1);
    expect(rec.audit.map((a) => a.action)).toEqual([
      'SSH_HOST_KEY_TRUSTED',
      'SSH_SESSION_OPENED',
      'SSH_SESSION_OPENED',
    ]);
    expect(rec.audit[0]?.detail).toEqual({ fingerprint: fingerprint(), saved: false });
  });

  it('saves the exact key the server presented after "trust and save"', async () => {
    const t = target(plainServer);
    const { broker, rec, controls } = setup(t, plainServer, {
      trusted: false,
      hostKeyAnswer: () => Promise.resolve('save'),
    });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(states(controls)).toContain('ACTIVE');
    });
    expect(rec.saved.map((k) => sha256Fingerprint(k))).toEqual([fingerprint()]);
  });

  it('refuses after "cancel", and asks no passphrase for a host the user did not trust', async () => {
    const t = target(lockedServer, { identityFiles: ['/keys/locked'] });
    const { broker, rec, controls } = setup(t, lockedServer, { trusted: false, answer: PASSPHRASE });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(rec.closed).toHaveLength(1);
    });
    expect(controls().find((c) => c.t === 'error')).toMatchObject({ code: 'HOST_KEY_UNKNOWN' });
    expect(rec.questions).toHaveLength(1);
    expect(rec.asked).toEqual([]);
  });

  it('asks for a passphrase only after the host is trusted, and only once across the retry', async () => {
    const t = target(lockedServer, { identityFiles: ['/keys/locked'] });
    const { broker, rec, controls } = setup(t, lockedServer, {
      trusted: false,
      answer: PASSPHRASE,
      hostKeyAnswer: () => Promise.resolve('once'),
    });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(states(controls)).toContain('ACTIVE');
    });
    expect(rec.questions).toHaveLength(1);
    expect(rec.asked).toEqual(['box:locked']);
  });

  it('never asks when the organisation turned trust on first use off', async () => {
    const t = target(plainServer);
    const { broker, rec, controls } = setup(t, plainServer, {
      trusted: false,
      trustOnFirstUse: false,
      hostKeyAnswer: () => Promise.resolve('save'),
    });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(rec.closed).toHaveLength(1);
    });
    expect(rec.questions).toEqual([]);
    expect(controls().find((c) => c.t === 'error')?.message).toContain('your organisation does not allow');
  });

  it('treats a different key as a hard error, OpenSSH style, with no question', async () => {
    const t = target(plainServer);
    const { broker, rec, controls } = setup(t, plainServer, {
      trusted: 'other',
      hostKeyAnswer: () => Promise.resolve('save'),
    });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(rec.closed).toHaveLength(1);
    });
    expect(rec.questions).toEqual([]);
    const error = controls().find((c) => c.t === 'error');
    expect(error).toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    expect(error?.message).toContain('REMOTE HOST IDENTIFICATION HAS CHANGED');
    expect(error?.message).toContain(fingerprint());
  });

  it('asks once for connections that wait on the same answer', async () => {
    const t = target(plainServer);
    let answer: (a: HostKeyAnswer) => void = () => undefined;
    const { broker, rec, controls } = setup(t, plainServer, {
      trusted: false,
      hostKeyAnswer: () => new Promise((resolve) => (answer = resolve)),
    });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(rec.questions).toHaveLength(1);
    });
    answer('once');
    await eventually(() => {
      expect(states(controls).filter((s) => s === 'ACTIVE')).toHaveLength(2);
    });
    expect(rec.questions).toHaveLength(1);
  });

  it('words a revoked key and a refused one plainly', () => {
    const presented = { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:abc' };
    expect(
      personalMessage(new DomainError('HOST_KEY_MISMATCH', 'x', { details: { presented, revoked: true } })),
    ).toBe('The host key (ssh-ed25519 SHA256:abc) is marked @revoked in your known_hosts. Do not connect.');
    expect(
      personalMessage(
        new DomainError('HOST_KEY_UNKNOWN', 'x', { details: { presented, reason: 'not_trusted' } }),
      ),
    ).toBe('The host key (ssh-ed25519 SHA256:abc) is not in your known_hosts and was not trusted.');
    expect(personalMessage(new DomainError('SSH_TIMEOUT'))).toBe('The remote system did not answer in time.');
  });
});

describe('embedded broker: unexpected failures', () => {
  it('logs one bounded line for an unexpected failure (the cause of INTERNAL_ERROR)', async () => {
    const warnings: string[] = [];
    const t = target(plainServer);
    const { broker, rec, controls } = setup(t, plainServer, {
      transport: {
        connect: () => Promise.reject(new Error('Unsupported algorithm: chacha20-poly1305@openssh.com')),
      },
      log: { warn: (message) => warnings.push(message) },
    });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(rec.closed).toHaveLength(1);
    });
    expect(controls().find((c) => c.t === 'error')).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(warnings).toEqual([
      `embedded broker: connect to ${t.id} failed unexpectedly (Error: Unsupported algorithm: chacha20-poly1305@openssh.com)`,
    ]);
  });

  it('logs nothing for a coded failure, such as a changed host key', async () => {
    const warnings: string[] = [];
    const t = target(plainServer);
    const { broker, rec } = setup(t, plainServer, {
      trusted: 'other',
      log: { warn: (message) => warnings.push(message) },
    });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await eventually(() => {
      expect(rec.closed).toHaveLength(1);
    });
    expect(warnings).toEqual([]);
  });

  it('keeps the line to one bounded line', () => {
    const line = describeUnexpected(
      'file read on personal-box',
      new TypeError(`a\nb   c ${'x'.repeat(1_000)}`),
    );
    expect(line).toMatch(
      /^embedded broker: file read on personal-box failed unexpectedly \(TypeError: a b c x+\)$/,
    );
    expect(line.length).toBeLessThan(400);
  });
});

describe('embedded broker: adding a personal host', () => {
  function adding(add: (host: NewPersonalHost) => Promise<PersonalTarget>) {
    const t = target(plainServer);
    const added: NewPersonalHost[] = [];
    const { broker, rec } = setup(t, plainServer, {
      targets: {
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(undefined),
        problems: () => Promise.resolve([]),
        add: (host) => {
          added.push(host);
          return add(host);
        },
      },
    });
    return { broker, rec, added };
  }

  it('adds the host, returns it without local detail, and records it in the local audit log', async () => {
    const { broker, rec, added } = adding((h) =>
      Promise.resolve({
        ...target(plainServer),
        id: `personal-${h.alias}`,
        alias: h.alias,
        host: h.host,
        port: 2222,
      }),
    );
    expect(await broker.addHost({ alias: 'lab-c', host: '10.20.1.7', port: 2222 })).toEqual({
      ok: true,
      value: {
        id: 'personal-lab-c',
        name: 'lab-c',
        host: '10.20.1.7',
        port: 2222,
        user: 'ada',
        viaJumpHost: false,
      },
    });
    expect(added).toEqual([{ alias: 'lab-c', host: '10.20.1.7', port: 2222 }]);
    expect(rec.audit).toContainEqual(
      expect.objectContaining({
        action: 'PERSONAL_HOST_ADDED',
        target: 'personal-lab-c',
        outcome: 'success',
      }),
    );
  });

  it('refuses a malformed request before the source sees it', async () => {
    const { broker, added } = adding(() => Promise.reject(new Error('not reached')));
    for (const request of [
      {},
      { alias: 'x', host: 'h', identityFile: '/etc/shadow' },
      { alias: 'x', host: 'h', port: '22' },
      { alias: 'x'.repeat(64), host: 'h' },
    ])
      expect(await broker.addHost(request as never)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(added).toEqual([]);
  });

  it("passes the source's coded refusal and message to the user", async () => {
    const { broker } = adding(() =>
      Promise.reject(new DomainError('CONFLICT', 'A host named lab-a already exists.')),
    );
    expect(await broker.addHost({ alias: 'lab-a', host: 'h' })).toEqual({
      ok: false,
      code: 'CONFLICT',
      message: 'A host named lab-a already exists.',
    });
  });
});

describe('embedded broker: test runs on personal targets (PHASE_11 §11.4)', () => {
  function withHostFiles(): SshTransport {
    return {
      connect: async (endpoint, credential, verifier) => {
        const connection = await ssh2Transport.connect(endpoint, credential, verifier);
        const sftp = wrapSftp(hostFiles as unknown as Parameters<typeof wrapSftp>[0]);
        return { ...connection, sftp: () => Promise.resolve(sftp) };
      },
    };
  }
  afterEach(() => {
    hostFiles = new FakeSftp({ home: '/home/ada' });
    hostRun = 'report';
    waiting = undefined;
  });
  const request = {
    framework: 'pytest',
    selector: { kind: 'file', path: 'tests/test_calculator.py' },
  } as const;
  const runControl = (controls: Record<string, unknown>[]) => controls.find((c) => c.t === 'run');

  it('runs the tests in the user’s home on the host, streams them and ends with the result', async () => {
    const t = target(plainServer);
    const { broker, rec, controls, output } = setup(t, plainServer, { transport: withHostFiles() });
    const started = await broker.runTests(randomUUID(), t.id, request);
    expect(started).toMatchObject({ ok: true, value: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown });
    const runId = started.ok ? started.value : '';
    await eventually(() => {
      expect(rec.closed).toHaveLength(1);
    });
    const command =
      plainServer.events.find((e) => e.includes(`.qe-runs/${runId}`) && !e.includes('kill -')) ?? '';
    expect(command).toContain("cd -- '/home/ada'");
    expect(command).toContain("'tests/test_calculator.py'");
    expect(output()).toContain('collected 5 items');
    expect(runControl(controls())).toMatchObject({
      result: { state: 'FAILED', counts: { total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 } },
    });
    expect(rec.audit.map((a) => a.action)).toEqual(['QE_TEST_STARTED', 'QE_TEST_FINISHED']);
    expect(rec.audit[1]).toMatchObject({ outcome: 'success', detail: { runId, state: 'FAILED', failed: 1 } });
  });

  it.each([
    [
      'an interrupt',
      (b: EmbeddedBroker, id: string) => b.send(id, JSON.stringify({ t: 'signal', signal: 'SIGINT' })),
    ],
    ['closing the stream', (b: EmbeddedBroker, id: string) => b.closeTerminal(id)],
  ])('cancels the run on the host on %s', async (_label, stop) => {
    hostRun = 'wait';
    const t = target(plainServer);
    const { broker, rec, controls, output } = setup(t, plainServer, { transport: withHostFiles() });
    const streamId = randomUUID();
    await broker.runTests(streamId, t.id, request);
    await eventually(() => {
      expect(output()).toContain('collected 5 items');
    });
    await stop(broker, streamId);
    await eventually(() => {
      expect(rec.audit.map((a) => a.action)).toContain('QE_TEST_FINISHED');
    });
    expect(rec.audit.at(-1)).toMatchObject({ detail: { state: 'CANCELLED' } });
    // Interrupted while still streaming: the IDE hears the result before the close.
    if (_label === 'an interrupt')
      expect(runControl(controls())).toMatchObject({ result: { state: 'CANCELLED' } });
  });

  it('refuses a malformed request, an unknown host and a selector the adapter refuses, running nothing', async () => {
    const t = target(plainServer);
    const { broker, rec, controls } = setup(t, plainServer, { transport: withHostFiles() });
    const before = plainServer.events.filter((e) => e.startsWith('exec:')).length;
    for (const bad of [{}, { framework: 'make', selector: { kind: 'all' } }, { ...request, extra: 1 }])
      expect(await broker.runTests(randomUUID(), t.id, bad)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await broker.runTests('not-a-uuid', t.id, request)).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
    expect(await broker.runTests(randomUUID(), 'personal-nope', request)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    // Well-formed, but a path out of the project: the adapter refuses it before any command is built.
    await broker.runTests(randomUUID(), t.id, {
      framework: 'pytest',
      selector: { kind: 'file', path: '../../etc/passwd' },
    });
    await eventually(() => {
      expect(rec.closed).toHaveLength(1);
    });
    expect(controls().find((c) => c.t === 'error')).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(plainServer.events.filter((e) => e.startsWith('exec:')).length).toBe(before);
  });
});
