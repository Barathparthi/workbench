/**
 * Remote test runs against a real OpenSSH server (PHASE_11 §Tests "Integration"): the sample pytest project run on
 * the target through an exec channel, its JUnit report left in `.qe-runs/<runId>/`, a run cancelled mid-way with
 * its whole process group, and a folder whose name is an injection attempt. Needs Docker.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { pytestAdapter, parseJUnit } from '@qe/runner';
import { startOpenSsh, type OpenSshFixture } from '@qe/test-utils/openssh';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHostKeyVerifier,
  remoteCancelCommand,
  remoteRunCommand,
  ssh2Transport,
  type ExecChannel,
  type SftpChannel,
  type SshConnection,
} from '../index.js';

// Tests run from the repository root.
const SAMPLE = 'tests/fixtures/sample-pytest-repo';
const RUN = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const CANCEL_RUN = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70';
const ROOT = '/home/qe/project';

let server: OpenSshFixture;
let connection: SshConnection;
let sftp: SftpChannel;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Copies the sample project to `root` on the server through SFTP, as the IDE's remote folder would. */
async function upload(root: string): Promise<void> {
  await sftp.mkdir(root);
  await sftp.mkdir(`${root}/tests`);
  for (const path of files(SAMPLE)) {
    await sftp.createFile(
      `${root}/${relative(SAMPLE, path).replaceAll('\\', '/')}`,
      readFileSync(path),
      0o644,
    );
  }
}

/** Runs a command line and collects its output until the channel closes. */
async function run(
  line: string,
): Promise<{ output: string; code: number | null; signal: string | null; channel: ExecChannel }> {
  const channel = await connection.exec(line);
  let output = '';
  channel.onData((data) => {
    output += data.toString('utf8');
  });
  return new Promise((done) => {
    channel.onClose((code, signal) => {
      done({ output, code, signal, channel });
    });
  });
}

beforeAll(async () => {
  server = await startOpenSsh();
  connection = await ssh2Transport.connect(
    server.endpoint,
    { kind: 'key', privateKey: server.clientKey },
    createHostKeyVerifier([server.hostKey]),
  );
  sftp = await connection.sftp();
  await upload(ROOT);
}, 240_000);

afterAll(async () => {
  sftp.close();
  connection.close();
  await server.stop();
});

describe('remote test runs over SSH exec', () => {
  it('runs the sample project on the target: 3 passed, 1 failed, 1 skipped, JUnit report in the run folder', async () => {
    const command = pytestAdapter.buildCommand(
      { kind: 'all' },
      { runId: RUN, python: 'python3', htmlReport: false },
    );
    const result = await run(remoteRunCommand({ root: ROOT, runId: RUN, command }));
    expect(result.code).toBe(1);
    expect(pytestAdapter.stateOf(result.code ?? -1)).toBe('FAILED');
    expect(result.output).toMatch(/1 failed, 3 passed, 1 skipped/);
    const report = await sftp.readFile(`${ROOT}/.qe-runs/${RUN}/junit.xml`, 10 * 1024 * 1024);
    const parsed = parseJUnit(report.data.toString('utf8'));
    expect(parsed.counts).toEqual({ total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 });
    expect(parsed.cases.find((c) => c.status === 'failed')).toMatchObject({
      file: 'tests/test_calculator.py',
      line: 21,
    });
    // The run left its folder and nothing else: no cache, no bytecode.
    expect(await server.run(`cd ${ROOT} && ls -A && ls -A tests`)).not.toMatch(/pytest_cache|__pycache__/);
  });

  it('cancels a run mid-way: SIGINT reaches pytest and everything it started', async () => {
    await sftp.createFile(
      `${ROOT}/tests/test_waits.py`,
      Buffer.from(
        'import subprocess, time\n\n\ndef test_waits():\n    subprocess.Popen(["sleep", "60"])\n    time.sleep(60)\n',
      ),
      0o644,
    );
    const command = pytestAdapter.buildCommand(
      { kind: 'file', path: 'tests/test_waits.py' },
      { runId: CANCEL_RUN, python: 'python3', htmlReport: false },
    );
    const running = run(remoteRunCommand({ root: ROOT, runId: CANCEL_RUN, command }));
    await new Promise((r) => setTimeout(r, 3_000));
    const started = Date.now();
    expect((await run(remoteCancelCommand(ROOT, CANCEL_RUN, 'INT'))).code).toBe(0);
    const result = await running;
    expect(Date.now() - started).toBeLessThan(10_000);
    // pytest's answer to SIGINT: interrupted (2), with what it had so far.
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/KeyboardInterrupt|Interrupted/);
    // The test's own child got SIGINT too (same group); KILL finds nothing left.
    expect((await run(remoteCancelCommand(ROOT, CANCEL_RUN, 'KILL'))).code).toBe(0);
    expect(await server.run('ps -o args | grep -c "[s]leep 60" || true')).toMatch(/^0/);
  });

  it('runs in a folder whose name is an injection attempt, and runs nothing else', async () => {
    const root = "/home/qe/qe dir'; touch pwned; '$(touch pwned)`touch pwned`";
    await upload(root);
    const command = pytestAdapter.buildCommand(
      { kind: 'node', id: 'tests/test_calculator.py::test_add' },
      { runId: RUN, python: 'python3', htmlReport: false },
    );
    const result = await run(
      remoteRunCommand({ root, runId: RUN, command, env: { NOTE: "'; touch pwned; '" } }),
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/1 passed/);
    expect(await server.run('find /home/qe -name pwned | wc -l')).toMatch(/^\s*0/);
  });
});
