import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ed25519KeyPair } from '@qe/test-utils';

import {
  createHostKeyVerifier,
  knownHostsName,
  knownHostsStore,
  mapSshError,
  sha256Fingerprint,
} from '../index.js';

/** A real ed25519 public key: the `ssh-ed25519 AAAA…` line, its blob and its fingerprint. */
function hostKey() {
  const line = ed25519KeyPair().public.trim();
  const base64 = line.split(' ')[1] ?? '';
  const blob = Buffer.from(base64, 'base64');
  return { entry: `ssh-ed25519 ${base64}`, blob, fingerprint: sha256Fingerprint(blob) };
}
/** How `ssh-keygen -H` writes a host: `|1|base64(salt)|base64(HMAC-SHA1(salt, name))`. */
function hashed(name: string): string {
  const salt = randomBytes(20);
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`;
}

const USER_FILE = '/home/ada/.ssh/known_hosts';
const QE_FILE = '/home/ada/.qe-workspace/known_hosts';
const store = (files: Record<string, string>) =>
  knownHostsStore({
    files: [USER_FILE, QE_FILE],
    saveTo: QE_FILE,
    read: (path) => Promise.resolve(files[path]),
  });

describe('known_hosts', () => {
  const lab = hostKey();
  const other = hostKey();
  const old = hostKey();

  it('finds plain, comma-separated, wildcard and hashed entries for a host', async () => {
    const s = store({
      [USER_FILE]: [
        '# a comment, then a blank line',
        '',
        `lab-a,10.20.1.5 ${lab.entry} ada@laptop`,
        `*.lab.corp ${other.entry}`,
        `${hashed('secret-box')} ${old.entry}`,
      ].join('\n'),
    });
    expect((await s.lookup('lab-a', 22)).trusted).toEqual([
      { algorithm: 'ssh-ed25519', fingerprintSha256: lab.fingerprint },
    ]);
    expect((await s.lookup('10.20.1.5', 22)).trusted).toHaveLength(1);
    expect((await s.lookup('build.lab.corp', 22)).trusted[0]?.fingerprintSha256).toBe(other.fingerprint);
    expect((await s.lookup('secret-box', 22)).trusted[0]?.fingerprintSha256).toBe(old.fingerprint);
    expect((await s.lookup('unknown', 22)).trusted).toEqual([]);
  });

  it('keeps ports apart: [host]:port entries match only that port', async () => {
    const s = store({ [USER_FILE]: `[lab-a]:2222 ${lab.entry}\n${hashed('[box]:2200')} ${other.entry}\n` });
    expect((await s.lookup('lab-a', 2222)).trusted).toHaveLength(1);
    expect((await s.lookup('lab-a', 22)).trusted).toEqual([]);
    expect((await s.lookup('box', 2200)).trusted).toHaveLength(1);
    expect(knownHostsName('box', 22)).toBe('box');
  });

  it('honours negation in host patterns', async () => {
    const s = store({ [USER_FILE]: `*.corp,!prod.corp ${lab.entry}\n` });
    expect((await s.lookup('dev.corp', 22)).trusted).toHaveLength(1);
    expect((await s.lookup('prod.corp', 22)).trusted).toEqual([]);
  });

  it('reads QE’s own file after the user’s', async () => {
    const s = store({ [USER_FILE]: `lab-a ${lab.entry}\n`, [QE_FILE]: `lab-a ${other.entry}\n` });
    expect((await s.lookup('lab-a', 22)).trusted.map((k) => k.fingerprintSha256)).toEqual([
      lab.fingerprint,
      other.fingerprint,
    ]);
  });

  it('lists @revoked keys, which the verifier refuses even where they are also trusted', async () => {
    const s = store({ [USER_FILE]: `lab-a ${old.entry}\n@revoked * ${old.entry}\n` });
    const record = await s.lookup('lab-a', 22);
    expect(record.revoked).toEqual([old.fingerprint]);
    const verifier = createHostKeyVerifier(record.trusted, { revoked: record.revoked });
    expect(verifier.verify(old.blob)).toBe(false);
    expect(verifier.outcome).toBe('revoked');
    expect(mapSshError(new Error('handshake failed'), verifier.outcome)).toBe('HOST_KEY_MISMATCH');
    // A revoked key is never "unknown": it can not be offered for trust on first use.
    const fresh = createHostKeyVerifier([], { revoked: record.revoked });
    fresh.verify(old.blob);
    expect(fresh.outcome).toBe('revoked');
  });

  it('does not trust @cert-authority lines (host certificates are not negotiated), nor malformed ones', async () => {
    const s = store({
      [USER_FILE]: [
        `@cert-authority *.corp ${lab.entry}`,
        `@unknown-marker box ${lab.entry}`,
        `box ssh-rsa ${lab.blob.toString('base64')}`, // the type field disagrees with the key
        'box ssh-ed25519',
        'box ssh-ed25519 !!!notbase64',
      ].join('\n'),
    });
    expect(await s.lookup('box', 22)).toEqual({ trusted: [], revoked: [] });
    expect((await s.lookup('build.corp', 22)).trusted).toEqual([]);
  });

  it('saves a trusted key to QE’s own file, readable only by the user, and finds it afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qe-known-hosts-'));
    const saveTo = join(dir, 'qe', 'known_hosts');
    const s = knownHostsStore({ files: [join(dir, 'missing'), saveTo], saveTo });
    await s.trust('lab-a', 2222, lab.blob);
    await s.trust('box', 22, other.blob);
    expect(await readFile(saveTo, 'utf8')).toBe(`[lab-a]:2222 ${lab.entry}\nbox ${other.entry}\n`);
    expect((await s.lookup('lab-a', 2222)).trusted[0]?.fingerprintSha256).toBe(lab.fingerprint);
    if (process.platform !== 'win32') {
      expect((await stat(saveTo)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, 'qe'))).mode & 0o777).toBe(0o700);
    }
    await expect(s.trust('x', 22, Buffer.from('not a key'))).rejects.toThrow('not an SSH public key');
  });
});
