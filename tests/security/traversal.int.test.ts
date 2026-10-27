/**
 * The traversal corpus against a real OpenSSH server (PHASE_09 §Tests "Security"): every file operation with every
 * corpus path, as an account that CAN write the canary directories outside the root. Only confinement keeps them
 * intact. Needs Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHostKeyVerifier,
  createRemoteFileSystem,
  ssh2Transport,
  type SftpChannel,
  type SshConnection,
} from '@qe/broker-core';
import { startOpenSsh, type OpenSshFixture } from '@qe/test-utils/openssh';

import {
  ACCEPTABLE,
  corpus,
  label,
  operations,
  outcome,
  OUTSIDE,
  ROOT,
  SIBLING,
  tree,
} from './traversal-corpus.js';

let server: OpenSshFixture;
let connection: SshConnection;
let sftp: SftpChannel;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Rebuilds the corpus tree on the server (the previous entry's operations may have changed it). */
async function resetTree(): Promise<void> {
  const lines = [
    `rm -rf ${quote(ROOT)} ${quote(OUTSIDE)} ${quote(SIBLING)}`,
    ...tree.dirs.map((d) => `mkdir -p ${quote(d)}`),
    ...Object.entries(tree.files).map(([p, c]) => `printf %s ${quote(c)} > ${quote(p)}`),
    ...Object.entries(tree.links).map(([p, t]) => `ln -s ${quote(t)} ${quote(p)}`),
  ];
  await server.run(lines.join(' && '));
}

/** Everything outside the root that the account could change: paths, types and content hashes. */
const outsideState = () =>
  server.run(
    `cd /home/qe && find outside work2 | sort | while read -r p; do printf '%s ' "$p"; ` +
      `if [ -f "$p" ]; then sha256sum < "$p"; else echo dir; fi; done`,
  );

beforeAll(async () => {
  server = await startOpenSsh();
  connection = await ssh2Transport.connect(
    server.endpoint,
    { kind: 'key', privateKey: server.clientKey },
    createHostKeyVerifier([server.hostKey]),
  );
  sftp = await connection.sftp();
}, 240_000);

afterAll(async () => {
  sftp.close();
  connection.close();
  await server.stop();
});

describe.each(corpus.map(([requested]) => ({ requested, name: label(requested) })))(
  'traversal corpus on OpenSSH: $name',
  ({ requested }) => {
    it('no file operation changes anything outside the root', async () => {
      await resetTree();
      const before = await outsideState();
      expect(before).toContain('outside/passwd');
      const fs = createRemoteFileSystem(sftp, { remoteRoot: ROOT, canWrite: true });
      for (const [name, run] of operations(fs, requested)) {
        const code = await outcome(run);
        expect(ACCEPTABLE.has(code), `${name} → ${code}`).toBe(true);
      }
      expect(await outsideState()).toBe(before);
    });
  },
);
