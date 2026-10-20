import { createHash, generateKeyPairSync } from 'node:crypto';

import { RegisterTargetRequest, RemoteRoot, TargetHost } from '@qe/contracts';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { authorize, devAuthenticator, makePrincipal } from '../auth.js';
import { errorHandler } from '../errors.js';
import { principalFor } from '../remote-session-service.js';
import { parsePublicKey, sha256Fingerprint } from '../target-service.js';

/** An OpenSSH `ssh-ed25519` public key line built from a fresh key pair. */
function ed25519Line(comment = 'admin@lab'): { line: string; blob: Buffer } {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  const blob = Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]);
  return { line: `ssh-ed25519 ${blob.toString('base64')} ${comment}`, blob };
}

describe('host keys', () => {
  it('computes the OpenSSH SHA256 fingerprint (unpadded base64 of the blob hash)', () => {
    const { line, blob } = ed25519Line();
    const expected = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
    expect(parsePublicKey(line)).toEqual({
      algorithm: 'ssh-ed25519',
      fingerprintSha256: expected,
      publicKey: line.split(' ').slice(0, 2).join(' '),
    });
    expect(sha256Fingerprint(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('refuses a key whose data does not match its declared type', () => {
    const { blob } = ed25519Line();
    expect(() => parsePublicKey(`ecdsa-sha2-nistp256 ${blob.toString('base64')}`)).toThrow('does not match');
    expect(() => parsePublicKey('ssh-ed25519 AAAA')).toThrow();
    expect(() => parsePublicKey('ssh-ed25519')).toThrow('not a public key');
  });
});

describe('target validation (contracts)', () => {
  it.each(['qe-linux-01.lab.corp', 'qe-linux-01', '10.20.1.5', 'fd00:1ab::5'])('accepts host %s', (h) => {
    expect(TargetHost.safeParse(h).success).toBe(true);
  });

  it.each([
    'http://x',
    'user@host',
    'host:22',
    '2130706433',
    '0177.0.0.1',
    '127.1',
    '0x7f000001',
    'fe80::1%eth0',
    'a b',
    '-lead.example',
    '',
  ])('rejects host %j', (h) => {
    expect(TargetHost.safeParse(h).success).toBe(false);
  });

  it.each(['/home/qe/projects', '/C:/Users/qe/src', '/srv/a-b_c.d'])('accepts remote root %s', (p) => {
    expect(RemoteRoot.safeParse(p).success).toBe(true);
  });

  it.each(['/', 'relative', '/a/../b', '/a/./b', '/a//b', '/a/', '/a\\b', '/a\u0000b'])(
    'rejects remote root %j',
    (p) => {
      expect(RemoteRoot.safeParse(p).success).toBe(false);
    },
  );

  it('never accepts raw secrets on registration', () => {
    const base = {
      name: 'qe-linux-01',
      host: 'qe-linux-01.lab.corp',
      remoteRoot: '/home/qe',
      policyId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f',
    };
    expect(RegisterTargetRequest.safeParse(base).success).toBe(true);
    for (const secret of ['privateKey', 'password', 'passphrase', 'token']) {
      expect(RegisterTargetRequest.safeParse({ ...base, [secret]: 'x' }).success).toBe(false);
    }
  });

  it('maps principals from the template', () => {
    expect(principalFor('{{user.username}}', 'bob')).toBe('bob');
    expect(principalFor('qeauto', 'bob')).toBe('qeauto');
  });
});

describe('internal routes', () => {
  const TOKEN = 'internal-service-token-for-tests-0123456789';
  const admin = makePrincipal({
    userId: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70',
    username: 'a',
    roles: ['qe.admin'],
  });

  async function app(token: string | undefined) {
    const a = Fastify();
    a.setErrorHandler(errorHandler);
    // Even a signed-in administrator's session never opens an internal route.
    a.addHook('onRequest', authorize(devAuthenticator(admin), token));
    a.post('/internal/x', { config: { permission: 'internal', audit: false } }, () => ({ ok: true }));
    await a.ready();
    return a;
  }

  it('accept only the service token as a bearer', async () => {
    const a = await app(TOKEN);
    expect(
      (await a.inject({ method: 'POST', url: '/internal/x', headers: { authorization: `Bearer ${TOKEN}` } }))
        .statusCode,
    ).toBe(200);
    for (const authorization of [
      undefined,
      `Bearer ${TOKEN}x`,
      `Basic ${TOKEN}`,
      'Bearer ',
      `bearer ${TOKEN}`,
    ]) {
      const res = await a.inject({
        method: 'POST',
        url: '/internal/x',
        headers: authorization ? { authorization } : {},
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('are closed entirely when no service token is configured', async () => {
    const a = await app(undefined);
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/internal/x',
          headers: { authorization: 'Bearer anything-at-all' },
        })
      ).statusCode,
    ).toBe(401);
  });
});
