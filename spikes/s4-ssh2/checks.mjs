// Spike S4: ssh2 deep-check against the local environment from env.sh.
// Prints one JSON result per check and a summary; exit code 1 if any check's expectation fails.
//   node checks.mjs            (ENV_DIR defaults to /srv/qe-s4)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import ssh2 from 'ssh2';

const { Client, utils } = ssh2;
const ENV = process.env.ENV_DIR ?? '/srv/qe-s4';
const HOST = '127.0.0.1';
const TARGET = 2222;
const BASTION = 2223;
const USER = 'qeuser';
const read = (p) => readFileSync(join(ENV, p));

// ---------------------------------------------------------------------------------------------------------
// Host keys: OpenSSH-style SHA256 fingerprint of the raw host key blob (base64, no padding).
const sha256Fingerprint = (blob) => `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
const fingerprintOfPubFile = (p) => sha256Fingerprint(Buffer.from(read(p).toString().split(' ')[1], 'base64'));
const sshKeygenFingerprint = (p) => {
  const r = spawnSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', join(ENV, p)], { encoding: 'utf8', shell: false });
  return r.stdout.split(' ')[1];
};
const pinned = {
  target: fingerprintOfPubFile('keys/target_host_ed25519.pub'),
  bastion: fingerprintOfPubFile('keys/bastion_host_ed25519.pub'),
};
/** Fail-closed verifier: accept only the pinned fingerprint, record what was presented. */
const pinnedVerifier = (expected, seen) => (key) => {
  const fp = sha256Fingerprint(key);
  seen.push(fp);
  return fp === expected;
};

// ---------------------------------------------------------------------------------------------------------
// Certificate auth: ssh2 has no certificate support, but publickey auth only needs `type`, `getPublicSSH()`
// and `sign()` from a parsed key. Present the certificate blob and algorithm, sign with the private key.
function certificateKey(privateKeyPem, certFile) {
  const parsed = utils.parseKey(privateKeyPem);
  if (parsed instanceof Error) throw parsed;
  const [certType, certB64] = read(certFile).toString().trim().split(' ');
  const certBlob = Buffer.from(certB64, 'base64');
  const key = Object.create(parsed); // inherits sign(), the private material and ssh2's parsed-key marker
  Object.defineProperty(key, 'type', { value: certType });
  key.getPublicSSH = () => certBlob;
  return key;
}

// ---------------------------------------------------------------------------------------------------------
function connect(cfg, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const client = new Client();
    const debugLog = [];
    let negotiated;
    const done = (result) => resolve({ client, debugLog, negotiated, ...result });
    const timer = setTimeout(() => done({ ok: false, error: { message: 'test timeout' } }), timeoutMs);
    client
      .on('handshake', (n) => (negotiated = n))
      .on('ready', () => {
        clearTimeout(timer);
        done({ ok: true });
      })
      .on('error', (e) => {
        clearTimeout(timer);
        done({ ok: false, error: { message: e.message, level: e.level, code: e.code } });
      })
      .connect({ readyTimeout: 5_000, debug: (m) => debugLog.push(m), ...cfg });
  });
}

const exec = (client, command) =>
  new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d) => (out += d)).on('close', (code) => resolve({ code, out: out.trim() }));
      stream.stderr.on('data', (d) => (out += d));
    });
  });

const keyAuth = { username: USER, privateKey: read('client/user_ed25519') };
const results = [];
async function check(name, expectation, fn) {
  try {
    const r = await fn();
    results.push({ name, expectation, pass: r.pass, ...r });
  } catch (e) {
    results.push({ name, expectation, pass: false, thrown: String(e?.message ?? e) });
  }
  console.log(JSON.stringify(results.at(-1)));
}
const credentialsSent = (log) => log.some((l) => l.includes('USERAUTH_REQUEST') || l.includes('SERVICE_REQUEST'));

// ---------------------------------------------------------------------------------------------------------
await check('fingerprint-matches-ssh-keygen', 'our SHA256 of the presented key == `ssh-keygen -l -E sha256`', async () => {
  const seen = [];
  const r = await connect({ host: HOST, port: TARGET, ...keyAuth, hostVerifier: pinnedVerifier(pinned.target, seen) });
  r.client.end();
  const keygen = sshKeygenFingerprint('keys/target_host_ed25519.pub');
  return { pass: r.ok && seen[0] === keygen, presented: seen[0], sshKeygen: keygen };
});

await check('default-accepts-any-host-key', 'documents ssh2 behaviour WITHOUT hostVerifier (must never be used)', async () => {
  const r = await connect({ host: HOST, port: TARGET, ...keyAuth });
  r.client.end();
  const accepted = r.debugLog.find((l) => l.includes('no verification'));
  return { pass: r.ok && Boolean(accepted), connected: r.ok, debug: accepted };
});

await check('host-key-mismatch-fails-before-auth', 'wrong pin → handshake error, no SERVICE/USERAUTH request sent', async () => {
  const seen = [];
  const r = await connect({ host: HOST, port: TARGET, ...keyAuth, hostVerifier: pinnedVerifier(pinned.bastion, seen) });
  r.client.end();
  return {
    pass: !r.ok && r.error.message.includes('Host denied') && !credentialsSent(r.debugLog),
    error: r.error,
    presented: seen[0],
    expected: pinned.bastion,
    credentialsSent: credentialsSent(r.debugLog),
  };
});

await check('async-host-verifier', 'callback-style verifier (e.g. DB/policy lookup) is awaited before auth', async () => {
  const r = await connect({
    host: HOST,
    port: TARGET,
    ...keyAuth,
    hostVerifier: (key, cb) => setTimeout(() => cb(sha256Fingerprint(key) === pinned.target), 150),
  });
  const id = r.ok ? await exec(r.client, 'id -un') : null;
  r.client.end();
  return { pass: r.ok && id?.out === USER, whoami: id?.out };
});

await check('negotiated-algorithms', 'records kex / host key / cipher actually negotiated with OpenSSH 9.6', async () => {
  const r = await connect({ host: HOST, port: TARGET, ...keyAuth, hostVerifier: pinnedVerifier(pinned.target, []) });
  r.client.end();
  return { pass: r.ok, negotiated: r.negotiated };
});

await check('certificate-auth', 'Vault-signed ed25519 user certificate accepted (key itself is NOT in authorized_keys)', async () => {
  const key = certificateKey(read('client/ephemeral_ed25519'), 'client/ephemeral_ed25519-cert.pub');
  const r = await connect({
    host: HOST,
    port: TARGET,
    username: USER,
    authHandler: [{ type: 'publickey', username: USER, key }],
    hostVerifier: pinnedVerifier(pinned.target, []),
  });
  const id = r.ok ? await exec(r.client, 'id -un') : null;
  r.client.end();
  return { pass: r.ok && id?.out === USER, whoami: id?.out, error: r.error };
});

await check('certificate-key-without-cert-rejected', 'the ephemeral key alone (no certificate) is rejected', async () => {
  const r = await connect({
    host: HOST,
    port: TARGET,
    username: USER,
    privateKey: read('client/ephemeral_ed25519'),
    hostVerifier: pinnedVerifier(pinned.target, []),
  });
  r.client.end();
  return { pass: !r.ok, error: r.error };
});

await check('certificate-wrong-principal-rejected', 'certificate for principal "otheruser" cannot log in as qeuser', async () => {
  const key = certificateKey(read('client/ephemeral_ed25519'), 'client/wrong-principal-cert.pub');
  const r = await connect({
    host: HOST,
    port: TARGET,
    username: USER,
    authHandler: [{ type: 'publickey', username: USER, key }],
    hostVerifier: pinnedVerifier(pinned.target, []),
  });
  r.client.end();
  return { pass: !r.ok, error: r.error };
});

await check('certificate-expired-rejected', 'a 5-second certificate is rejected once expired', async () => {
  const key = certificateKey(read('client/ephemeral_ed25519'), 'client/short-lived-cert.pub');
  const validTo = spawnSync('ssh-keygen', ['-L', '-f', join(ENV, 'client/short-lived-cert.pub')], { encoding: 'utf8' })
    .stdout.match(/to (\S+)/)?.[1];
  const waitMs = Math.max(0, new Date(validTo).getTime() - Date.now() + 2_000);
  await new Promise((r) => setTimeout(r, waitMs));
  const r = await connect({
    host: HOST,
    port: TARGET,
    username: USER,
    authHandler: [{ type: 'publickey', username: USER, key }],
    hostVerifier: pinnedVerifier(pinned.target, []),
  });
  r.client.end();
  return { pass: !r.ok, validTo, error: r.error };
});

await check('agent-auth-linux', 'key held by ssh-agent (SSH_AUTH_SOCK), private key never read by the client', async () => {
  const sock = join(ENV, 'run', `agent-${process.pid}.sock`);
  const agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore', shell: false });
  try {
    for (let i = 0; i < 50 && spawnSync('test', ['-S', sock]).status !== 0; i++) await new Promise((r) => setTimeout(r, 100));
    const add = spawnSync('ssh-add', [join(ENV, 'client/user_ed25519')], { env: { SSH_AUTH_SOCK: sock }, encoding: 'utf8' });
    const r = await connect({ host: HOST, port: TARGET, username: USER, agent: sock, hostVerifier: pinnedVerifier(pinned.target, []) });
    const id = r.ok ? await exec(r.client, 'id -un') : null;
    r.client.end();
    return { pass: r.ok && id?.out === USER, sshAdd: add.stderr.trim(), whoami: id?.out, error: r.error };
  } finally {
    agent.kill();
  }
});

await check('agent-with-certificate', 'certificate loaded into ssh-agent: does ssh2 agent auth use it?', async () => {
  const sock = join(ENV, 'run', `agent-cert-${process.pid}.sock`);
  const agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore', shell: false });
  try {
    for (let i = 0; i < 50 && spawnSync('test', ['-S', sock]).status !== 0; i++) await new Promise((r) => setTimeout(r, 100));
    // ssh-add picks up ephemeral_ed25519-cert.pub next to the key and adds key + certificate.
    const add = spawnSync('ssh-add', [join(ENV, 'client/ephemeral_ed25519')], { env: { SSH_AUTH_SOCK: sock }, encoding: 'utf8' });
    const r = await connect({ host: HOST, port: TARGET, username: USER, agent: sock, hostVerifier: pinnedVerifier(pinned.target, []) });
    const id = r.ok ? await exec(r.client, 'id -un') : null;
    r.client.end();
    // Informational: the result decides whether the broker can rely on an agent for certificates.
    return { pass: true, worked: r.ok && id?.out === USER, sshAdd: add.stderr.trim(), error: r.error };
  } finally {
    agent.kill();
  }
});

await check('jump-host', 'bastion (pinned) → forwardOut → target (pinned separately) over the tunnel', async () => {
  const seenB = [];
  const seenT = [];
  const b = await connect({ host: HOST, port: BASTION, ...keyAuth, hostVerifier: pinnedVerifier(pinned.bastion, seenB) });
  if (!b.ok) return { pass: false, bastion: b.error };
  const stream = await new Promise((res, rej) => b.client.forwardOut('127.0.0.1', 0, HOST, TARGET, (e, s) => (e ? rej(e) : res(s))));
  const t = await connect({ sock: stream, ...keyAuth, hostVerifier: pinnedVerifier(pinned.target, seenT) });
  const id = t.ok ? await exec(t.client, 'id -un') : null;
  t.client.end();
  b.client.end();
  return { pass: t.ok && id?.out === USER, bastionKey: seenB[0], targetKey: seenT[0], whoami: id?.out };
});

await check('jump-host-permitopen-enforced', 'bastion refuses to forward anywhere except 127.0.0.1:2222', async () => {
  const b = await connect({ host: HOST, port: BASTION, ...keyAuth, hostVerifier: pinnedVerifier(pinned.bastion, []) });
  const err = await new Promise((res) => b.client.forwardOut('127.0.0.1', 0, HOST, 22, (e) => res(e)));
  b.client.end();
  return { pass: Boolean(err), error: err?.message };
});

await check('target-forwarding-disabled', 'target (AllowTcpForwarding no) refuses forwardOut', async () => {
  const r = await connect({ host: HOST, port: TARGET, ...keyAuth, hostVerifier: pinnedVerifier(pinned.target, []) });
  const err = await new Promise((res) => r.client.forwardOut('127.0.0.1', 0, HOST, BASTION, (e) => res(e)));
  r.client.end();
  return { pass: Boolean(err), error: err?.message };
});

/** Opens a PTY shell and returns helpers to run a line and wait for a marker in the output. */
async function ptyShell(client, rows, cols) {
  const stream = await new Promise((res, rej) =>
    client.shell({ term: 'xterm-256color', rows, cols }, (e, s) => (e ? rej(e) : res(s))),
  );
  let buf = '';
  stream.on('data', (d) => (buf += d.toString()));
  const waitFor = (re, ms = 5_000) =>
    new Promise((res) => {
      const start = Date.now();
      const t = setInterval(() => {
        const m = buf.match(re);
        if (m || Date.now() - start > ms) {
          clearInterval(t);
          res(m ? { match: m, ms: Date.now() - start } : null);
        }
      }, 25);
    });
  return { stream, waitFor, clear: () => (buf = '') };
}

await check('pty-resize', 'PTY opened at 24x80 reports "24 80"; setWindow(40,120) → "40 120"', async () => {
  const r = await connect({ host: HOST, port: TARGET, ...keyAuth, hostVerifier: pinnedVerifier(pinned.target, []) });
  const sh = await ptyShell(r.client, 24, 80);
  sh.stream.write('echo SIZE1=$(stty size)\n');
  const a = await sh.waitFor(/SIZE1=(\d+ \d+)/);
  sh.stream.setWindow(40, 120, 0, 0);
  await new Promise((res) => setTimeout(res, 200));
  sh.stream.write('echo SIZE2=$(stty size)\n');
  const b = await sh.waitFor(/SIZE2=(\d+ \d+)/);
  r.client.end();
  return { pass: a?.match[1] === '24 80' && b?.match[1] === '40 120', before: a?.match[1], after: b?.match[1] };
});

await check('interrupt-ctrl-c-vs-signal', 'Ctrl+C (\\x03 through the PTY) vs SSH "signal" request for a foreground `sleep 30`', async () => {
  const r = await connect({ host: HOST, port: TARGET, ...keyAuth, hostVerifier: pinnedVerifier(pinned.target, []) });
  const sh = await ptyShell(r.client, 24, 80);
  // Interactive bash drops the rest of a command line when its foreground job is interrupted, so the marker
  // is sent as its own line: it runs within milliseconds if `sleep` was interrupted, after ~30 s if not.
  const tryInterrupt = async (label, interrupt) => {
    sh.clear();
    sh.stream.write('sleep 30\n');
    await new Promise((res) => setTimeout(res, 500));
    interrupt();
    sh.stream.write(`echo ${label}_$?\n`);
    const m = await sh.waitFor(new RegExp(`${label}_(\\d+)`), 3_000);
    return m ? { interruptedAfterMs: m.ms, exitStatus: m.match[1] } : null;
  };
  const viaSignal = await tryInterrupt('AFTER_SIGNAL', () => sh.stream.signal('INT'));
  if (!viaSignal) {
    sh.stream.write('\x03'); // still sleeping: clear it before the next attempt
    await sh.waitFor(/AFTER_SIGNAL_(\d+)/, 3_000);
  }
  const viaCtrlC = await tryInterrupt('AFTER_CTRLC', () => sh.stream.write('\x03'));
  r.client.end();
  return {
    pass: Boolean(viaCtrlC),
    ctrlC: viaCtrlC ?? 'not interrupted within 3s',
    signalRequest: viaSignal ?? 'not interrupted within 3s',
  };
});

await check('unreachable-port', 'closed port → fast ECONNREFUSED (maps to SSH_UNREACHABLE)', async () => {
  const t0 = Date.now();
  const r = await connect({ host: HOST, port: 2299, ...keyAuth, hostVerifier: pinnedVerifier(pinned.target, []) });
  return { pass: !r.ok && r.error.code === 'ECONNREFUSED', ms: Date.now() - t0, error: r.error };
});

await check('silent-server-timeout', 'TCP accepted but no SSH banner → readyTimeout (maps to SSH_TIMEOUT)', async () => {
  const sockets = new Set();
  const silent = createServer((s) => sockets.add(s));
  await new Promise((res) => silent.listen(0, HOST, res));
  const { port } = silent.address();
  const t0 = Date.now();
  const r = await connect({ host: HOST, port, ...keyAuth, readyTimeout: 2_000, hostVerifier: pinnedVerifier(pinned.target, []) });
  for (const s of sockets) s.destroy();
  silent.close();
  return { pass: !r.ok && r.error.level === 'client-timeout', ms: Date.now() - t0, error: r.error };
});

await check('bad-credentials', 'unauthorized key → all auth methods failed (maps to CREDENTIALS_REJECTED)', async () => {
  const r = await connect({
    host: HOST,
    port: TARGET,
    username: USER,
    privateKey: utils.generateKeyPairSync('ed25519').private,
    hostVerifier: pinnedVerifier(pinned.target, []),
  });
  r.client.end();
  return { pass: !r.ok && r.error.level === 'client-authentication', error: r.error };
});

await check('sftp-basics', 'SFTP subsystem: realpath, write, read back, stat, remove', async () => {
  const r = await connect({ host: HOST, port: TARGET, ...keyAuth, hostVerifier: pinnedVerifier(pinned.target, []) });
  const sftp = await new Promise((res, rej) => r.client.sftp((e, s) => (e ? rej(e) : res(s))));
  const p = (fn, ...a) => new Promise((res, rej) => sftp[fn](...a, (e, v) => (e ? rej(e) : res(v))));
  const home = await p('realpath', '.');
  const file = `${home}/qe-s4-sftp.txt`;
  await p('writeFile', file, 'hello from ssh2 sftp\n');
  const back = (await p('readFile', file)).toString();
  const st = await p('stat', file);
  await p('unlink', file);
  r.client.end();
  return { pass: back === 'hello from ssh2 sftp\n' && st.size === 21, home, size: st.size };
});

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ summary: { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name) } }));
process.exitCode = failed.length ? 1 : 0;
