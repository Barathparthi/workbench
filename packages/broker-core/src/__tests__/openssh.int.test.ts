/**
 * The SSH transport against a real OpenSSH server (Phase 08 test table): interoperability that the in-process ssh2
 * server cannot prove — PTY size via `stty`, Ctrl+C interrupting a foreground job, host-key pinning. CI only (Docker).
 */
import { fileURLToPath } from 'node:url';

import ssh2 from 'ssh2';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createHostKeyVerifier, mapSshError, ssh2Transport, type SshConnection } from '../index.js';

const CONTEXT = fileURLToPath(new URL('../../../test-utils/openssh/', import.meta.url));

let container: StartedTestContainer;
let fingerprint: string;
let clientKey: Buffer;
const connections: SshConnection[] = [];

beforeAll(async () => {
  const keys = ssh2.utils.generateKeyPairSync('ed25519');
  clientKey = Buffer.from(keys.private);
  const image = await GenericContainer.fromDockerfile(CONTEXT).build('qews-test-openssh', {
    deleteOnExit: true,
  });
  container = await image
    .withExposedPorts(22)
    .withCopyContentToContainer([
      { content: `${keys.public}\n`, target: '/etc/ssh/authorized_keys/qe', mode: 0o644 },
    ])
    .start();
  const out = await container.exec([
    'ssh-keygen',
    '-l',
    '-E',
    'sha256',
    '-f',
    '/etc/ssh/ssh_host_ed25519_key.pub',
  ]);
  fingerprint = /SHA256:[A-Za-z0-9+/]{43}/.exec(out.output)?.[0] ?? '';
  expect(fingerprint).not.toBe('');
}, 240_000);

afterAll(async () => {
  connections.forEach((c) => {
    c.close();
  });
  await container.stop();
});

const endpoint = () => ({ address: container.getHost(), port: container.getMappedPort(22), username: 'qe' });
const pinned = () => createHostKeyVerifier([{ algorithm: 'ssh-ed25519', fingerprintSha256: fingerprint }]);

async function shell(cols = 80, rows = 24) {
  const conn = await ssh2Transport.connect(endpoint(), { kind: 'key', privateKey: clientKey }, pinned());
  connections.push(conn);
  const pty = await conn.shell({ cols, rows, term: 'xterm-256color' });
  let out = '';
  pty.onData((d) => (out += d.toString()));
  const run = (line: string) => {
    pty.write(Buffer.from(`${line}\n`));
  };
  return { pty, run, output: () => out };
}

describe('ssh2 transport against OpenSSH', () => {
  it('our SHA256 of the presented key equals ssh-keygen’s', async () => {
    const verifier = pinned();
    const conn = await ssh2Transport.connect(endpoint(), { kind: 'key', privateKey: clientKey }, verifier);
    connections.push(conn);
    expect(verifier.outcome).toBe('match');
    expect(verifier.presented?.fingerprintSha256).toBe(fingerprint);
  });

  it('opens the PTY at the requested size and follows resizes', async () => {
    const s = await shell(100, 30);
    s.run('stty size');
    await vi.waitFor(
      () => {
        expect(s.output()).toContain('30 100');
      },
      { timeout: 10_000 },
    );
    s.pty.setWindow(40, 132);
    s.run('stty size');
    await vi.waitFor(
      () => {
        expect(s.output()).toContain('40 132');
      },
      { timeout: 10_000 },
    );
  });

  it('Ctrl+C (0x03 through the PTY) interrupts a foreground job', async () => {
    const s = await shell();
    s.run('sleep 30; echo SLEPT');
    await new Promise((r) => setTimeout(r, 500));
    s.pty.write(Uint8Array.of(0x03));
    s.run('echo AFTER-$?');
    await vi.waitFor(
      () => {
        expect(s.output()).toContain('AFTER-130');
      },
      { timeout: 10_000 },
    );
    expect(s.output()).not.toContain('SLEPT\r');
  });

  it('refuses a different host key before authenticating', async () => {
    const verifier = createHostKeyVerifier([
      { algorithm: 'ssh-ed25519', fingerprintSha256: `SHA256:${'A'.repeat(43)}` },
    ]);
    const error = await ssh2Transport
      .connect(endpoint(), { kind: 'key', privateKey: clientKey }, verifier)
      .catch((e: unknown) => e);
    expect(mapSshError(error, verifier.outcome)).toBe('HOST_KEY_MISMATCH');
  });

  it('reports an unknown key as CREDENTIALS_REJECTED', async () => {
    const other = Buffer.from(ssh2.utils.generateKeyPairSync('ed25519').private);
    const verifier = pinned();
    const error = await ssh2Transport
      .connect(endpoint(), { kind: 'key', privateKey: other }, verifier)
      .catch((e: unknown) => e);
    expect(mapSshError(error, verifier.outcome)).toBe('CREDENTIALS_REJECTED');
  });
});
