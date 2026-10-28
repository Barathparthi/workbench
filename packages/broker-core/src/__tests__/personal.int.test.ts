/**
 * Personal targets against a real OpenSSH server and a real ssh-agent (PHASE_10 §Tests "Integration"): a host from a
 * `~/.ssh/config`, its key checked against `known_hosts`, signed in through the agent or a key file. Needs Docker and
 * OpenSSH's client tools (ssh-agent, ssh-add); skipped on Windows, where the agent is a named pipe.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ed25519KeyPair } from '@qe/test-utils';
import { startOpenSsh, type OpenSshFixture } from '@qe/test-utils/openssh';

import {
  createHostKeyVerifier,
  detectAgent,
  knownHostsStore,
  mapSshError,
  personalCredentials,
  sshConfigTargetSource,
  ssh2Transport,
  type PersonalTarget,
  type SshCredential,
} from '../index.js';

const onWindows = process.platform === 'win32';
let server: OpenSshFixture;
let home: string;
let agentSocket: string;
let agentPid: number | undefined;
let hostKeyLine: string;

async function connect(
  target: PersonalTarget,
  credential: SshCredential,
  knownHosts: string,
): Promise<string> {
  await writeFile(join(home, '.ssh', 'known_hosts'), knownHosts);
  const store = knownHostsStore({
    files: [join(home, '.ssh', 'known_hosts')],
    saveTo: join(home, 'qe_known_hosts'),
  });
  const record = await store.lookup(target.host, target.port);
  const verifier = createHostKeyVerifier(record.trusted, { revoked: record.revoked });
  try {
    const connection = await ssh2Transport.connect(
      { address: target.host, port: target.port, username: target.user },
      credential,
      verifier,
    );
    const pty = await connection.shell({ cols: 80, rows: 24, term: 'xterm' });
    let out = '';
    pty.onData((d) => (out += d.toString()));
    pty.write(Buffer.from('echo PERSONAL-$((40+2)); exit\n'));
    await new Promise<void>((resolve) => {
      pty.onClose(() => {
        resolve();
      });
    });
    connection.close();
    return /PERSONAL-42/.test(out) ? 'connected' : `connected, no output: ${out}`;
  } catch (error) {
    return mapSshError(error, verifier.outcome);
  }
}

describe.skipIf(onWindows)('personal targets on OpenSSH', () => {
  beforeAll(async () => {
    server = await startOpenSsh();
    home = await mkdtemp(join(tmpdir(), 'qe-personal-'));
    await mkdir(join(home, '.ssh'), { mode: 0o700 });
    // The fixture's key is the one the server accepts: it becomes the user's key file and goes into the agent.
    await writeFile(join(home, '.ssh', 'id_lab'), server.clientKey, { mode: 0o600 });
    await writeFile(
      join(home, '.ssh', 'config'),
      `Host lab\n  HostName ${server.endpoint.address}\n  Port ${String(server.endpoint.port)}\n  User qe\n` +
        `  IdentityFile ~/.ssh/id_lab\n`,
    );
    hostKeyLine = (await server.run('cat /etc/ssh/ssh_host_ed25519_key.pub'))
      .trim()
      .split(' ')
      .slice(0, 2)
      .join(' ');

    agentSocket = join(home, 'agent.sock');
    const agent = spawn('ssh-agent', ['-D', '-a', agentSocket], { stdio: 'ignore', shell: false });
    agentPid = agent.pid;
    for (
      let i = 0;
      i < 50 && spawnSync('ssh-add', ['-l'], { env: { SSH_AUTH_SOCK: agentSocket } }).status === 2;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const added = spawnSync('ssh-add', [join(home, '.ssh', 'id_lab')], {
      env: { SSH_AUTH_SOCK: agentSocket },
      shell: false,
    });
    expect(added.status).toBe(0);
  }, 240_000);

  afterAll(async () => {
    if (agentPid !== undefined) process.kill(agentPid);
    await server.stop();
    await rm(home, { recursive: true, force: true });
  });

  const lab = async () => {
    const t = await sshConfigTargetSource({ home, localUser: 'ada' }).get('personal:lab');
    if (t === undefined) throw new Error('lab target missing');
    return t;
  };
  const knownHosts = () => {
    const t = `[${server.endpoint.address}]:${String(server.endpoint.port)}`;
    return `${t} ${hostKeyLine}\n`;
  };

  it('signs in through the ssh-agent', async () => {
    const target = await lab();
    // Only the agent: the key file is moved out of the way so it cannot be what works.
    const creds = await personalCredentials(
      { ...target, identityFiles: [join(home, 'nowhere')] },
      {
        home,
        agent: detectAgent({ SSH_AUTH_SOCK: agentSocket }, 'linux'),
        askPassphrase: () => Promise.resolve(undefined),
      },
    );
    expect(creds.first).toMatchObject({ agent: agentSocket, keys: [] });
    expect(await connect(target, creds.first as SshCredential, knownHosts())).toBe('connected');
  });

  it('signs in with the key file from ~/.ssh/config when there is no agent', async () => {
    const target = await lab();
    const creds = await personalCredentials(target, {
      home,
      agent: undefined,
      askPassphrase: () => Promise.resolve(undefined),
    });
    expect(await connect(target, creds.first as SshCredential, knownHosts())).toBe('connected');
  });

  it('refuses a host whose key differs from known_hosts, before any credential is used', async () => {
    const target = await lab();
    const creds = await personalCredentials(target, {
      home,
      agent: undefined,
      askPassphrase: () => Promise.resolve(undefined),
    });
    const wrong = `[${server.endpoint.address}]:${String(server.endpoint.port)} ${ed25519KeyPair().public.trim().split(' ').slice(0, 2).join(' ')}\n`;
    expect(await connect(target, creds.first as SshCredential, wrong)).toBe('HOST_KEY_MISMATCH');
    await chmod(join(home, '.ssh', 'known_hosts'), 0o600);
  });
});
