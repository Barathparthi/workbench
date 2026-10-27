/**
 * A disposable OpenSSH server (Alpine, `packages/test-utils/openssh`) for integration tests, with a fresh client key
 * for the account `qe` and the host key's SHA256 fingerprint as `ssh-keygen` prints it. Needs Docker.
 * Imported as `@qe/test-utils/openssh` so unit tests never load Testcontainers.
 */
import { fileURLToPath } from 'node:url';

import ssh2 from 'ssh2';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

const CONTEXT = fileURLToPath(new URL('../openssh/', import.meta.url));

export interface OpenSshFixture {
  readonly endpoint: { readonly address: string; readonly port: number; readonly username: string };
  readonly clientKey: Buffer;
  readonly hostKey: { readonly algorithm: 'ssh-ed25519'; readonly fingerprintSha256: string };
  /** Runs a shell script in the container as `qe` ("the server side"); rejects on a non-zero exit. */
  run(script: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startOpenSsh(): Promise<OpenSshFixture> {
  const keys = ssh2.utils.generateKeyPairSync('ed25519');
  const image = await GenericContainer.fromDockerfile(CONTEXT).build('qews-test-openssh', {
    deleteOnExit: true,
  });
  const container: StartedTestContainer = await image
    .withExposedPorts(22)
    .withCopyContentToContainer([
      { content: `${keys.public}\n`, target: '/etc/ssh/authorized_keys/qe', mode: 0o644 },
    ])
    .start();
  const keygen = await container.exec([
    'ssh-keygen',
    '-l',
    '-E',
    'sha256',
    '-f',
    '/etc/ssh/ssh_host_ed25519_key.pub',
  ]);
  const fingerprintSha256 = /SHA256:[A-Za-z0-9+/]{43}/.exec(keygen.output)?.[0];
  if (fingerprintSha256 === undefined) throw new Error('no host key fingerprint');
  return {
    endpoint: { address: container.getHost(), port: container.getMappedPort(22), username: 'qe' },
    clientKey: Buffer.from(keys.private),
    hostKey: { algorithm: 'ssh-ed25519', fingerprintSha256 },
    async run(script) {
      const result = await container.exec(['sh', '-c', script], { user: 'qe' });
      if (result.exitCode !== 0)
        throw new Error(`script failed (${String(result.exitCode)}): ${result.output}`);
      return result.output;
    },
    async stop() {
      await container.stop();
    },
  };
}
