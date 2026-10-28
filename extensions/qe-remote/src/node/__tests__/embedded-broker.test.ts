import { randomUUID } from 'node:crypto';

import {
  DomainError,
  sha256Fingerprint,
  ssh2Transport,
  wrapSftp,
  type AuditSink,
  type HostKeyStore,
  type LocalAuditEvent,
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
import { EmbeddedBroker, personalMessage, type EmbeddedBrokerDeps } from '../embedded-broker';

const PASSPHRASE = 'correct horse';
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

let plainServer: TestSshServer;
let lockedServer: TestSshServer;
const lockedKey = encryptedKey();

beforeAll(async () => {
  plainServer = await startSshServer();
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
    await vi.waitFor(() => {
      expect(controls().map((c) => c.state ?? c.t)).toEqual(['CONNECTING', 'hostkey', 'ACTIVE']);
    });
    expect(controls()[1]).toMatchObject({ algorithm: 'ssh-ed25519', verified: true });
    expect(plainServer.events).toContain('pty:100x30:xterm-256color');
    await broker.send(id, Uint8Array.of(0x00, ...Buffer.from('hello\r')));
    await vi.waitFor(() => {
      expect(output()).toContain('echo:hello');
    });
    await broker.closeTerminal(id);
    await vi.waitFor(() => {
      expect(rec.closed).toHaveLength(1);
    });
    expect(rec.audit.map((a) => a.action)).toEqual(['SSH_SESSION_OPENED', 'SSH_SESSION_CLOSED']);
  });

  it('asks for a passphrase only after the plain keys were rejected, then signs in with the unlocked key', async () => {
    const t = target(lockedServer, { identityFiles: ['/keys/plain', '/keys/locked'] });
    const { broker, rec, controls } = setup(t, lockedServer, { answer: PASSPHRASE });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await vi.waitFor(() => {
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
      await vi.waitFor(() => {
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
    await vi.waitFor(() => {
      expect(controls().map((c) => c.state ?? c.t)).toContain('ACTIVE');
    });
    broker.dispose();
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
      expect(states(controls)).toContain('ACTIVE');
    });
    expect(rec.saved.map((k) => sha256Fingerprint(k))).toEqual([fingerprint()]);
  });

  it('refuses after "cancel", and asks no passphrase for a host the user did not trust', async () => {
    const t = target(lockedServer, { identityFiles: ['/keys/locked'] });
    const { broker, rec, controls } = setup(t, lockedServer, { trusted: false, answer: PASSPHRASE });
    await broker.openTerminal(randomUUID(), t.id, { cols: 80, rows: 24 });
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
      expect(rec.questions).toHaveLength(1);
    });
    answer('once');
    await vi.waitFor(() => {
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
