import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createHostKeyVerifier,
  fileDevCredentialSource,
  keyAlgorithm,
  mapSshError,
  PACKAGE_NAME,
  SessionRegistry,
  sha256Fingerprint,
  ssh2Transport,
  TerminalBridge,
  type PtyChannel,
  type SshConnection,
  type StreamSocket,
} from '../index.js';
import { startSshServer, type TestSshServer } from '@qe/test-utils';

describe('@qe/broker-core', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qe/broker-core');
  });
});

describe('host keys', () => {
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from('ssh-ed25519'),
    Buffer.from([0, 0, 0, 2, 1, 2]),
  ]);
  const fp = sha256Fingerprint(blob);

  it('computes OpenSSH fingerprints and reads the key type', () => {
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(keyAlgorithm(blob)).toBe('ssh-ed25519');
    expect(keyAlgorithm(Buffer.from([0, 0]))).toBe('unknown');
    expect(keyAlgorithm(Buffer.from([0, 0, 1, 0, 1]))).toBe('unknown');
  });

  it('accepts only a trusted fingerprint and tells unknown from mismatch', () => {
    const match = createHostKeyVerifier([{ algorithm: 'ssh-ed25519', fingerprintSha256: fp }]);
    expect(match.outcome).toBeUndefined();
    expect(match.verify(blob)).toBe(true);
    expect(match.outcome).toBe('match');
    expect(match.presented).toEqual({ algorithm: 'ssh-ed25519', fingerprintSha256: fp });

    const other = createHostKeyVerifier([
      { algorithm: 'ssh-ed25519', fingerprintSha256: `SHA256:${'B'.repeat(43)}` },
    ]);
    expect(other.verify(blob)).toBe(false);
    expect(other.outcome).toBe('mismatch');

    const none = createHostKeyVerifier([]);
    expect(none.verify(blob)).toBe(false);
    expect(none.outcome).toBe('unknown');
  });
});

describe('mapSshError', () => {
  it.each([
    [{ level: 'client-authentication' }, undefined, 'CREDENTIALS_REJECTED'],
    [{ level: 'client-timeout' }, undefined, 'SSH_TIMEOUT'],
    [{ code: 'ETIMEDOUT' }, undefined, 'SSH_TIMEOUT'],
    [{ level: 'client-socket', code: 'ECONNREFUSED' }, undefined, 'SSH_UNREACHABLE'],
    [{ code: 'EHOSTUNREACH' }, undefined, 'SSH_UNREACHABLE'],
    [{ level: 'handshake' }, 'mismatch', 'HOST_KEY_MISMATCH'],
    [{ level: 'handshake' }, 'unknown', 'HOST_KEY_UNKNOWN'],
    [new Error('weird'), undefined, 'INTERNAL_ERROR'],
    ['string error', undefined, 'INTERNAL_ERROR'],
  ] as const)('%j (%s) → %s', (error, outcome, code) => {
    expect(mapSshError(error, outcome)).toBe(code);
  });
});

describe('ssh2 transport against a real SSH server', () => {
  let server: TestSshServer;
  beforeAll(async () => {
    server = await startSshServer();
  });
  afterAll(async () => {
    await server.close();
  });

  const endpoint = () => ({ address: '127.0.0.1', port: server.port, username: 'qe' });
  const trusted = () =>
    createHostKeyVerifier([
      { algorithm: 'ssh-ed25519', fingerprintSha256: sha256Fingerprint(server.hostKeyBlob) },
    ]);

  async function shellOf(conn: SshConnection) {
    const pty = await conn.shell({ cols: 100, rows: 30, term: 'xterm-256color' });
    let out = '';
    pty.onData((d) => (out += d.toString()));
    return { pty, output: () => out };
  }

  it('connects with a pinned host key and runs an interactive PTY (resize, Ctrl+C, exit)', async () => {
    const verifier = trusted();
    const conn = await ssh2Transport.connect(
      endpoint(),
      { kind: 'key', privateKey: server.clientKey },
      verifier,
    );
    expect(verifier.outcome).toBe('match');
    const { pty, output } = await shellOf(conn);
    expect(server.events).toContain('pty:100x30:xterm-256color');
    await vi.waitFor(() => {
      expect(output()).toContain('ready$');
    });
    pty.write(Buffer.from('hello\r'));
    await vi.waitFor(() => {
      expect(output()).toContain('echo:hello');
    });
    pty.setWindow(40, 120);
    await vi.waitFor(() => {
      expect(server.events).toContain('resize:120x40');
    });
    pty.write(Uint8Array.of(0x03));
    await vi.waitFor(() => {
      expect(server.events).toContain('ctrl-c');
    });
    const exited = new Promise<number | null>((resolve) => {
      pty.onClose((code) => {
        resolve(code);
      });
    });
    pty.write(Buffer.from('exit\r'));
    expect(await exited).toBe(0);
    conn.close();
  });

  it('pauses, resumes and ends the PTY, and reports the connection closing', async () => {
    const conn = await ssh2Transport.connect(
      endpoint(),
      { kind: 'key', privateKey: server.clientKey },
      trusted(),
    );
    const { pty, output } = await shellOf(conn);
    await vi.waitFor(() => {
      expect(output()).toContain('ready$');
    });
    pty.pause();
    pty.resume();
    pty.write(Buffer.from('after-resume\r'));
    await vi.waitFor(() => {
      expect(output()).toContain('echo:after-resume');
    });
    const closed = new Promise<void>((resolve) => {
      conn.onClose(resolve);
    });
    pty.end();
    conn.close();
    await closed;
  });

  it('fails closed on a host-key mismatch before any credential is sent', async () => {
    const before = server.events.filter((e) => e.startsWith('auth')).length;
    const verifier = createHostKeyVerifier([
      { algorithm: 'ssh-ed25519', fingerprintSha256: `SHA256:${'C'.repeat(43)}` },
    ]);
    const error = await ssh2Transport
      .connect(endpoint(), { kind: 'key', privateKey: server.clientKey }, verifier)
      .catch((e: unknown) => e);
    expect(mapSshError(error, verifier.outcome)).toBe('HOST_KEY_MISMATCH');
    expect(server.events.filter((e) => e.startsWith('auth')).length).toBe(before);
  });

  it('refuses an unknown host key (nothing trusted on record)', async () => {
    const verifier = createHostKeyVerifier([]);
    const error = await ssh2Transport
      .connect(endpoint(), { kind: 'key', privateKey: server.clientKey }, verifier)
      .catch((e: unknown) => e);
    expect(mapSshError(error, verifier.outcome)).toBe('HOST_KEY_UNKNOWN');
  });

  it('reports a rejected key as CREDENTIALS_REJECTED', async () => {
    const other = (await import('ssh2')).default.utils.generateKeyPairSync('ed25519');
    const verifier = trusted();
    const error = await ssh2Transport
      .connect(endpoint(), { kind: 'key', privateKey: Buffer.from(other.private) }, verifier)
      .catch((e: unknown) => e);
    expect(mapSshError(error, verifier.outcome)).toBe('CREDENTIALS_REJECTED');
  });

  it('reports a closed port as SSH_UNREACHABLE', async () => {
    const verifier = trusted();
    const error = await ssh2Transport
      .connect(
        { address: '127.0.0.1', port: 1, username: 'qe' },
        { kind: 'password', password: 'x' },
        verifier,
      )
      .catch((e: unknown) => e);
    expect(mapSshError(error, verifier.outcome)).toBe('SSH_UNREACHABLE');
  });

  it('refuses to connect without a verifier', async () => {
    await expect(
      ssh2Transport.connect(endpoint(), { kind: 'password', password: 'x' }, {} as never),
    ).rejects.toThrow('host key verifier required');
  });
});

/** Fake socket and PTY for the bridge. */
function fakes(bufferedAmount = 0) {
  const sent: (Uint8Array | string)[] = [];
  const closes: [number, string | undefined][] = [];
  const socket: StreamSocket & { bufferedAmount: number } = {
    bufferedAmount,
    send: (d) => sent.push(d),
    close: (code, reason) => closes.push([code, reason]),
  };
  const written: Uint8Array[] = [];
  const windows: [number, number][] = [];
  let dataListener: ((d: Buffer) => void) | undefined;
  let closeListener: ((c: number | null, s: string | null) => void) | undefined;
  const state = { paused: false, ended: false };
  const channel: PtyChannel = {
    write: (d) => written.push(d),
    setWindow: (rows, cols) => windows.push([rows, cols]),
    pause: () => (state.paused = true),
    resume: () => (state.paused = false),
    end: () => (state.ended = true),
    onData: (l) => (dataListener = l),
    onClose: (l) => (closeListener = l),
  };
  return {
    socket,
    channel,
    sent,
    closes,
    written,
    windows,
    state,
    emit: (d: string) => dataListener?.(Buffer.from(d)),
    exit: (code: number) => closeListener?.(code, null),
  };
}

const input = (text: string) => Uint8Array.from([0x00, ...Buffer.from(text)]);
const json = (o: object) => JSON.stringify(o);
const later = () => new Date(Date.now() + 3_600_000);

describe('TerminalBridge', () => {
  it('queues input and control that arrive before the shell opens, then replays them in order', () => {
    const f = fakes();
    const bridge = new TerminalBridge(f.socket, { idleMs: 60_000, expiresAt: later() });
    bridge.handleMessage(input('ls\r'), true);
    bridge.handleMessage(json({ t: 'resize', cols: 120, rows: 40 }), false);
    expect(f.written).toEqual([]);
    bridge.attach(f.channel);
    expect(f.windows).toEqual([[40, 120]]);
    expect(Buffer.from(f.written[0] ?? []).toString()).toBe('ls\r');
    bridge.close('client_closed');
  });

  it('streams output as prefixed frames and maps signals to control bytes', () => {
    const f = fakes();
    const bridge = new TerminalBridge(f.socket, { idleMs: 60_000, expiresAt: later() });
    bridge.attach(f.channel);
    f.emit('hi');
    expect(Array.from(f.sent[0] as Uint8Array)).toEqual([0x01, ...Buffer.from('hi')]);
    bridge.handleMessage(json({ t: 'signal', signal: 'SIGINT' }), false);
    bridge.handleMessage(json({ t: 'signal', signal: 'SIGQUIT' }), false);
    expect(f.written.map((w) => Array.from(w))).toEqual([[0x03], [0x1c]]);
    bridge.handleMessage(json({ t: 'ack', bytes: 2 }), false);
    bridge.handleMessage(json({ t: 'signal', signal: 'SIGTERM' }), false);
    expect(f.state.ended).toBe(true);
    bridge.close('client_closed');
  });

  it.each([
    ['an unknown control message', json({ t: 'exec', cmd: 'rm' }), false],
    ['bad JSON', '{oops', false],
    ['a binary frame of the wrong type', Uint8Array.of(0x01, 1), true],
    ['oversized input', new Uint8Array(16 * 1024 + 2), true],
  ] as const)('closes with 4008 on %s', (_label, data, binary) => {
    const f = fakes();
    const bridge = new TerminalBridge(f.socket, { idleMs: 60_000, expiresAt: later() });
    bridge.attach(f.channel);
    bridge.handleMessage(data, binary);
    expect(f.closes).toEqual([[4008, 'protocol_error']]);
    expect(f.state.ended).toBe(true);
  });

  it('reports the exit code and closes normally when the remote shell exits, exactly once', () => {
    const f = fakes();
    const bridge = new TerminalBridge(f.socket, { idleMs: 60_000, expiresAt: later() });
    const results: unknown[] = [];
    bridge.onClosed((r) => results.push(r));
    bridge.attach(f.channel);
    bridge.handleMessage(input('abc'), true);
    f.emit('xyz!');
    f.exit(3);
    bridge.close('revoked');
    expect(f.sent).toContain(json({ t: 'exit', code: 3, signal: null }));
    expect(f.closes).toEqual([[1000, 'remote_exited']]);
    expect(results).toEqual([{ reason: 'remote_exited', bytesIn: 3, bytesOut: 4, exitCode: 3 }]);
    bridge.onClosed((r) => results.push(r)); // late listener still learns the result
    expect(results).toHaveLength(2);
    expect(bridge.isClosed).toBe(true);
  });

  it('ends idle sessions (4010) and expired ones', () => {
    vi.useFakeTimers();
    try {
      const idle = fakes();
      const b1 = new TerminalBridge(idle.socket, { idleMs: 1_000, expiresAt: later() });
      b1.attach(idle.channel);
      vi.advanceTimersByTime(999);
      idle.emit('keepalive'); // output counts as activity
      vi.advanceTimersByTime(999);
      expect(idle.closes).toEqual([]);
      vi.advanceTimersByTime(2);
      expect(idle.closes).toEqual([[4010, 'idle_timeout']]);

      const exp = fakes();
      const b2 = new TerminalBridge(exp.socket, { idleMs: 60_000, expiresAt: new Date(Date.now() + 500) });
      b2.attach(exp.channel);
      vi.advanceTimersByTime(501);
      expect(exp.closes).toEqual([[4010, 'session_expired']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses the remote shell while the browser cannot keep up and resumes when it drains', () => {
    vi.useFakeTimers();
    try {
      const f = fakes();
      const bridge = new TerminalBridge(f.socket, {
        idleMs: 60_000,
        expiresAt: later(),
        highWaterBytes: 10,
        lowWaterBytes: 5,
      });
      bridge.attach(f.channel);
      f.socket.bufferedAmount = 100;
      f.emit('a lot of output');
      expect(f.state.paused).toBe(true);
      vi.advanceTimersByTime(100);
      expect(f.state.paused).toBe(true);
      f.socket.bufferedAmount = 0;
      vi.advanceTimersByTime(25);
      expect(f.state.paused).toBe(false);
      bridge.close('client_closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a shell that opens after the session was closed', () => {
    const f = fakes();
    const bridge = new TerminalBridge(f.socket, { idleMs: 60_000, expiresAt: later() });
    bridge.handleMessage(json({ t: 'close' }), false);
    bridge.attach(f.channel);
    expect(f.state.ended).toBe(true);
    expect(f.closes).toEqual([[1000, 'client_closed']]);
    bridge.sendControl({ t: 'status', state: 'ACTIVE' });
    expect(f.sent).toEqual([]);
  });
});

describe('SessionRegistry', () => {
  it('closes one session, a user’s sessions, or all, and forgets closed ones', () => {
    const registry = new SessionRegistry();
    const make = (sessionId: string, userId: string) => {
      const f = fakes();
      const bridge = new TerminalBridge(f.socket, { idleMs: 60_000, expiresAt: later() });
      registry.add({ sessionId, userId, targetId: 't', bridge });
      return f;
    };
    const a = make('s1', 'u1');
    make('s2', 'u1');
    const c = make('s3', 'u2');
    expect(registry.countForUser('u1')).toBe(2);
    expect(registry.close('s1', 'revoked')).toBe(true);
    expect(a.closes).toEqual([[4011, 'revoked']]);
    expect(registry.has('s1')).toBe(false);
    expect(registry.close('nope', 'revoked')).toBe(false);
    expect(registry.closeUser('u1', 'revoked')).toBe(1);
    expect(registry.closeAll('shutdown')).toBe(1);
    expect(c.closes).toEqual([[4013, 'shutdown']]);
    expect(registry.size).toBe(0);
  });
});

describe('fileDevCredentialSource', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qews-keys-'));
    await mkdir(join(dir, 'lab-a'));
    await writeFile(join(dir, 'lab-a', 'id_ed25519'), 'PRIVATE KEY');
    await writeFile(join(tmpdir(), 'qews-outside-key'), 'OUTSIDE');
    await symlink(join(tmpdir(), 'qews-outside-key'), join(dir, 'escape')).catch(() => undefined);
  });
  const ref = (providerPath: string, provider = 'file_dev', method = 'vault_key') => ({
    provider,
    method,
    providerPath,
    metadata: {},
  });

  it('reads a key file under its directory', async () => {
    const cred = await fileDevCredentialSource(dir).resolve(ref('lab-a/id_ed25519'), 'bob');
    expect(cred).toEqual({ kind: 'key', privateKey: Buffer.from('PRIVATE KEY') });
  });

  it.each([
    ['a path outside the directory', '../qews-outside-key'],
    ['an absolute path', join(tmpdir(), 'qews-outside-key')],
    ['a missing file', 'lab-a/missing'],
    ['the directory itself', '.'],
  ])('refuses %s', async (_label, path) => {
    await expect(fileDevCredentialSource(dir).resolve(ref(path), 'bob')).rejects.toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
    });
  });

  it('refuses a symlink leading out of the directory (when the OS allows creating one)', async () => {
    await expect(fileDevCredentialSource(dir).resolve(ref('escape'), 'bob')).rejects.toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
    });
  });

  it('refuses references that are not development key files', async () => {
    await expect(
      fileDevCredentialSource(dir).resolve(ref('lab-a/id_ed25519', 'vault'), 'bob'),
    ).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    await expect(
      fileDevCredentialSource(dir).resolve(ref('lab-a/id_ed25519', 'file_dev', 'ssh_certificate'), 'bob'),
    ).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
  });
});
