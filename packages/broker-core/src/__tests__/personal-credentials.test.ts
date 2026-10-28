import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ed25519KeyPair, startSshServer, type TestSshServer } from '@qe/test-utils';

import {
  createHostKeyVerifier,
  detectAgent,
  localAuditLog,
  mapSshError,
  personalCredentials,
  sha256Fingerprint,
  ssh2Transport,
  WINDOWS_OPENSSH_AGENT,
  type PersonalTarget,
  type SshCredential,
} from '../index.js';

const HOME = '/home/ada';
const target = (over: Partial<PersonalTarget> = {}): PersonalTarget => ({
  id: 'personal:box',
  alias: 'box',
  host: '127.0.0.1',
  port: 22,
  user: 'ada',
  identityFiles: [],
  identitiesOnly: false,
  source: 'ssh-config',
  ...over,
});

/** An encrypted OpenSSH private key (and its public half) that ssh2 can parse with the passphrase. */
function encryptedKey(passphrase: string): { private: string; public: string } {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 2 });
    if (!(ssh2.utils.parseKey(pair.private, passphrase) instanceof Error)) return pair;
  }
}

describe('detectAgent', () => {
  it('uses SSH_AUTH_SOCK wherever it is set', () => {
    expect(detectAgent({ SSH_AUTH_SOCK: '/tmp/agent.1' }, 'linux', () => false)).toBe('/tmp/agent.1');
    expect(detectAgent({ SSH_AUTH_SOCK: '/tmp/agent.1' }, 'win32', () => true)).toBe('/tmp/agent.1');
  });

  it('on Windows uses the OpenSSH agent pipe, else Pageant; elsewhere nothing', () => {
    expect(detectAgent({}, 'win32', (p) => p === WINDOWS_OPENSSH_AGENT)).toBe(WINDOWS_OPENSSH_AGENT);
    expect(detectAgent({}, 'win32', () => false)).toBe('pageant');
    expect(detectAgent({ SSH_AUTH_SOCK: '' }, 'darwin', () => false)).toBeUndefined();
  });
});

describe('personal credentials', () => {
  const plain = ed25519KeyPair();
  const locked = encryptedKey('correct horse');

  const files = (entries: Record<string, string>) => (path: string) =>
    Promise.resolve(entries[path] === undefined ? undefined : Buffer.from(entries[path]));

  it('tries the agent first, then the key files that need no passphrase, without asking anything', async () => {
    const ask = vi.fn<(p: string) => Promise<string | undefined>>();
    const creds = await personalCredentials(
      target({ identityFiles: ['/k/plain', '/k/locked', '/k/missing'] }),
      {
        home: HOME,
        agent: '/tmp/agent.1',
        askPassphrase: ask,
        read: files({ '/k/plain': plain.private, '/k/locked': locked.private }),
      },
    );
    expect(creds.first).toEqual({
      kind: 'methods',
      agent: '/tmp/agent.1',
      keys: [{ privateKey: Buffer.from(plain.private) }],
    });
    expect(creds.encryptedKeys).toEqual(['/k/locked']);
    expect(ask).not.toHaveBeenCalled();
  });

  it('unlocks an encrypted key only when asked, retrying a wrong passphrase, never with the agent again', async () => {
    const ask = vi
      .fn<(p: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce('correct horse');
    const creds = await personalCredentials(target({ identityFiles: ['/k/locked'] }), {
      home: HOME,
      agent: '/tmp/agent.1',
      askPassphrase: ask,
      read: files({ '/k/locked': locked.private }),
    });
    expect(creds.first).toEqual({ kind: 'methods', agent: '/tmp/agent.1', keys: [] });
    expect(await creds.unlock()).toEqual({
      kind: 'methods',
      keys: [{ privateKey: Buffer.from(locked.private), passphrase: 'correct horse' }],
    });
    expect(ask.mock.calls.map(([p]) => p)).toEqual(['/k/locked', '/k/locked']);
  });

  it('gives up on a key after three wrong passphrases or a cancel', async () => {
    const wrong = vi.fn<(p: string) => Promise<string | undefined>>().mockResolvedValue('wrong');
    const options = { home: HOME, agent: undefined, read: files({ '/k/locked': locked.private }) };
    const t = target({ identityFiles: ['/k/locked'] });
    expect(
      await (await personalCredentials(t, { ...options, askPassphrase: wrong })).unlock(),
    ).toBeUndefined();
    expect(wrong).toHaveBeenCalledTimes(3);
    const cancel = vi.fn<(p: string) => Promise<string | undefined>>().mockResolvedValue(undefined);
    expect(
      await (await personalCredentials(t, { ...options, askPassphrase: cancel })).unlock(),
    ).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('leaves the agent out with IdentitiesOnly, uses OpenSSH’s default key files, skips non-keys', async () => {
    const creds = await personalCredentials(target({ identitiesOnly: true }), {
      home: HOME,
      agent: '/tmp/agent.1',
      askPassphrase: () => Promise.resolve(undefined),
      read: files({
        [join(HOME, '.ssh', 'id_ed25519')]: 'not a key',
        [join(HOME, '.ssh', 'id_rsa')]: plain.private,
        [join(HOME, '.ssh', 'id_ecdsa')]: plain.public, // a public key is not a credential
      }),
    });
    expect(creds.first).toEqual({ kind: 'methods', keys: [{ privateKey: Buffer.from(plain.private) }] });
  });

  it('has nothing to offer without an agent or keys', async () => {
    const creds = await personalCredentials(target(), {
      home: HOME,
      agent: undefined,
      askPassphrase: () => Promise.resolve(undefined),
      read: () => Promise.resolve(undefined),
    });
    expect(creds.first).toBeUndefined();
    expect(await creds.unlock()).toBeUndefined();
  });
});

describe('ssh2 transport with a credential chain (agent and key files)', () => {
  let ssh: TestSshServer;
  beforeAll(async () => {
    ssh = await startSshServer();
  });
  afterAll(async () => {
    await ssh.close();
  });

  const connect = (credential: SshCredential) => {
    const verifier = createHostKeyVerifier([
      { algorithm: 'ssh-ed25519', fingerprintSha256: sha256Fingerprint(ssh.hostKeyBlob) },
    ]);
    return ssh2Transport
      .connect({ address: '127.0.0.1', port: ssh.port, username: 'ada' }, credential, verifier)
      .then(
        (c) => {
          c.close();
          return 'connected';
        },
        (e: unknown) => mapSshError(e, verifier.outcome),
      );
  };
  const other = Buffer.from(ed25519KeyPair().private);

  it('goes on to the key files when the agent cannot be reached', async () => {
    const agent = process.platform === 'win32' ? '\\\\.\\pipe\\qe-no-such-agent' : '/nonexistent/agent.sock';
    expect(await connect({ kind: 'methods', agent, keys: [{ privateKey: ssh.clientKey }] })).toBe(
      'connected',
    );
  });

  it('tries the keys in order', async () => {
    expect(
      await connect({ kind: 'methods', keys: [{ privateKey: other }, { privateKey: ssh.clientKey }] }),
    ).toBe('connected');
  });

  it('reports a chain the server rejects as CREDENTIALS_REJECTED', async () => {
    expect(await connect({ kind: 'methods', keys: [{ privateKey: other }] })).toBe('CREDENTIALS_REJECTED');
  });
});

describe('local audit log', () => {
  it('appends one JSON line per event, readable only by the user, and rotates at its size limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qe-audit-'));
    const path = join(dir, '.qe-workspace', 'audit.log');
    const log = localAuditLog({ path, maxBytes: 200, now: () => new Date('2026-10-28T09:00:00Z') });
    await log.record({ action: 'SSH_SESSION_OPENED', target: 'personal:box', outcome: 'success' });
    await log.record({
      action: 'SSH_HOST_KEY_TRUSTED',
      target: 'personal:box',
      outcome: 'success',
      detail: { saved: true },
    });
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      {
        time: '2026-10-28T09:00:00.000Z',
        action: 'SSH_SESSION_OPENED',
        target: 'personal:box',
        outcome: 'success',
      },
      {
        time: '2026-10-28T09:00:00.000Z',
        action: 'SSH_HOST_KEY_TRUSTED',
        target: 'personal:box',
        outcome: 'success',
        detail: { saved: true },
      },
    ]);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    await log.record({ action: 'SSH_SESSION_CLOSED', target: 'personal:box', outcome: 'success' });
    expect(await readFile(`${path}.1`, 'utf8')).toContain('SSH_HOST_KEY_TRUSTED');
    expect(await readFile(path, 'utf8')).toContain('SSH_SESSION_CLOSED');
  });

  it('never fails the caller when the log cannot be written', async () => {
    const log = localAuditLog({ path: join(tmpdir(), '\0invalid', 'audit.log') });
    await expect(
      log.record({ action: 'X', target: 'personal:box', outcome: 'failure' }),
    ).resolves.toBeUndefined();
  });
});
