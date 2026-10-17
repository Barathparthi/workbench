// Spike S3 stub broker: just enough of the 05_API_CONTRACTS session/stream/fs contract to drive a remote
// terminal and remote files from a Theia frontend, backed by ssh2 against the S4 test target.
//
//   POST /api/v1/targets/:targetId/sessions      { kind: 'terminal' | 'files', terminal?: { cols, rows } }
//   WS   /api/v1/sessions/:id/stream              subprotocols: 'qews.v1', 'ticket.<base64url>'
//   POST /api/v1/sessions/:id/fs/:op              stat | list | read | write | mkdir | delete | rename
//
// NOT production code: no user authentication (a real control plane checks the session cookie and RBAC),
// one hard-coded target, tickets in memory. Host keys are pinned and Origins allowlisted as the contract says.
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { posix } from 'node:path';

import ssh2 from 'ssh2';
import { WebSocketServer } from 'ws';

const ENV = process.env.ENV_DIR ?? '/srv/qe-s4';
const PORT = Number(process.env.BROKER_PORT ?? 8082);
const REMOTE_ROOT = process.env.REMOTE_ROOT ?? '/home/qeuser/project';
// Spike: any loopback origin (browser app on :3000/:8080).
const ORIGIN_OK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
// Theia's Electron renderer is loaded from file://, so its WebSocket carries `Origin: file://` (its fetches
// carry none). The stub lets that through to show the transport works; a real broker cannot use the Origin
// to tell the desktop app from any local HTML file — see docs/spikes/S3_REMOTE_TERMINAL_FS.md.
const DESKTOP_ORIGIN = 'file://';
const TARGET = {
  id: 'tg_lab1',
  host: '127.0.0.1',
  port: 2222,
  username: 'qeuser',
  privateKey: readFileSync(`${ENV}/client/user_ed25519`),
  fingerprint: (() => {
    const blob = Buffer.from(readFileSync(`${ENV}/keys/target_host_ed25519.pub`, 'utf8').split(' ')[1], 'base64');
    return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  })(),
};

const sessions = new Map(); // id → { kind, ticket?, ticketExpires, used, cols, rows, files? }
const log = (...a) => console.log(new Date().toISOString(), ...a);

function sshConnect() {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({
        host: TARGET.host,
        port: TARGET.port,
        username: TARGET.username,
        privateKey: TARGET.privateKey,
        readyTimeout: 5_000,
        // S4 rule: never connect without a verifier; compare the pinned SHA256 fingerprint.
        hostVerifier: (key) =>
          `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === TARGET.fingerprint,
      });
  });
}

/** Confine a client path to REMOTE_ROOT (08_REMOTE_CONNECTIVITY_DESIGN §confine, simplified). */
function confine(requested = '') {
  if (requested.includes('\0') || requested.startsWith('/') || /^[a-zA-Z]:/.test(requested)) throw httpError(403, 'PATH_OUTSIDE_ROOT');
  const full = posix.normalize(posix.join(REMOTE_ROOT, requested.replace(/\\/g, '/')));
  if (full !== REMOTE_ROOT && !full.startsWith(`${REMOTE_ROOT}/`)) throw httpError(403, 'PATH_OUTSIDE_ROOT');
  return full;
}
const httpError = (status, code) => Object.assign(new Error(code), { status, code });

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGIN_OK.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  return !origin || ORIGIN_OK.test(origin);
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => (raw += d)).on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(httpError(400, 'INVALID_REQUEST'));
      }
    });
  });

const sftpOf = async (session) => {
  if (!session.files) {
    const client = await sshConnect();
    const sftp = await new Promise((res, rej) => client.sftp((e, s) => (e ? rej(e) : res(s))));
    session.files = { client, sftp };
  }
  return session.files.sftp;
};
const call = (sftp, fn, ...args) => new Promise((res, rej) => sftp[fn](...args, (e, v) => (e ? rej(e) : res(v))));
const typeOf = (attrs) => (attrs.isDirectory() ? 'directory' : attrs.isSymbolicLink() ? 'symlink' : 'file');
const etagOf = (attrs) => `"${attrs.size}-${attrs.mtime}"`;

const fsOps = {
  async stat(sftp, { path }) {
    const a = await call(sftp, 'stat', confine(path));
    return { type: typeOf(a), size: a.size, mtimeMs: a.mtime * 1000, mode: a.mode, etag: etagOf(a) };
  },
  async list(sftp, { path }) {
    const list = await call(sftp, 'readdir', confine(path));
    return {
      entries: list.map((e) => ({ name: e.filename, type: typeOf(e.attrs), size: e.attrs.size, mtimeMs: e.attrs.mtime * 1000 })),
      truncated: false,
    };
  },
  async read(sftp, { path }) {
    const full = confine(path);
    const [buf, a] = await Promise.all([call(sftp, 'readFile', full), call(sftp, 'stat', full)]);
    return { contentBase64: buf.toString('base64'), etag: etagOf(a) };
  },
  async write(sftp, { path, contentBase64 }) {
    const full = confine(path);
    await call(sftp, 'writeFile', full, Buffer.from(contentBase64, 'base64'));
    return { etag: etagOf(await call(sftp, 'stat', full)) };
  },
  async mkdir(sftp, { path }) {
    await call(sftp, 'mkdir', confine(path));
    return {};
  },
  async delete(sftp, { path }) {
    const full = confine(path);
    const a = await call(sftp, 'stat', full);
    await call(sftp, a.isDirectory() ? 'rmdir' : 'unlink', full);
    return {};
  },
  async rename(sftp, { from, to }) {
    await call(sftp, 'rename', confine(from), confine(to));
    return {};
  },
};

const server = createServer(async (req, res) => {
  try {
    if (!cors(req, res)) return send(res, 403, { code: 'CSRF_REJECTED' });
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url, 'http://broker');
    let m;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/v1\/targets\/([^/]+)\/sessions$/))) {
      if (m[1] !== TARGET.id) return send(res, 404, { code: 'NOT_FOUND' });
      const body = await readJson(req);
      const id = `ss_${randomBytes(6).toString('hex')}`;
      const ticket = randomBytes(24).toString('base64url');
      sessions.set(id, {
        kind: body.kind,
        ticket,
        ticketExpires: Date.now() + 60_000,
        used: false,
        cols: body.terminal?.cols ?? 80,
        rows: body.terminal?.rows ?? 24,
      });
      log('session', id, body.kind, 'origin', req.headers.origin);
      return send(res, 201, {
        sessionId: id,
        kind: body.kind,
        state: 'AUTHORIZED',
        streamUrl: `/api/v1/sessions/${id}/stream`,
        ...(body.kind === 'terminal' ? { ticket } : {}),
      });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/fs\/([a-z]+)$/))) {
      const session = sessions.get(m[1]);
      if (!session || session.kind !== 'files') return send(res, 404, { code: 'NOT_FOUND' });
      const op = fsOps[m[2]];
      if (!op) return send(res, 400, { code: 'INVALID_REQUEST' });
      const result = await op(await sftpOf(session), await readJson(req));
      log('fs', m[2]);
      return send(res, 200, result);
    }
    return send(res, 404, { code: 'NOT_FOUND' });
  } catch (e) {
    const status = e.status ?? (e.code === 2 ? 404 : 500); // SFTP code 2 = no such file
    send(res, status, { code: e.status ? e.code : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', message: e.message });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, handleProtocols: (p) => (p.has('qews.v1') ? 'qews.v1' : false) });
server.on('upgrade', (req, socket, head) => {
  const m = new URL(req.url, 'http://broker').pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/stream$/);
  const session = m && sessions.get(m[1]);
  const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
  const ticket = protocols.find((p) => p.startsWith('ticket.'))?.slice(7);
  const reject = (code) => {
    log('ws reject', code, req.headers.origin);
    socket.end(`HTTP/1.1 ${code} Rejected\r\n\r\n`);
  };
  const origin = req.headers.origin ?? '';
  if (!ORIGIN_OK.test(origin) && origin !== DESKTOP_ORIGIN) return reject(403);
  if (!session || session.kind !== 'terminal' || session.used || ticket !== session.ticket || Date.now() > session.ticketExpires) return reject(401);
  session.used = true; // single-use
  wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, session));
});

async function attachTerminal(ws, session) {
  const sendJson = (o) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
  // Frames can arrive before the SSH shell is open (the client types immediately): queue them.
  const pending = [];
  let handle = (data, isBinary) => pending.push([data, isBinary]);
  ws.on('message', (data, isBinary) => handle(data, isBinary));
  sendJson({ t: 'status', state: 'CONNECTING' });
  let client;
  try {
    client = await sshConnect();
  } catch (e) {
    sendJson({ t: 'error', code: 'SSH_UNREACHABLE', message: e.message });
    return ws.close(4500);
  }
  sendJson({ t: 'hostkey', algorithm: 'ssh-ed25519', fingerprintSha256: TARGET.fingerprint, verified: true });
  client.shell({ term: 'xterm-256color', cols: session.cols, rows: session.rows }, (err, stream) => {
    if (err) {
      sendJson({ t: 'error', code: 'INTERNAL_ERROR', message: err.message });
      return ws.close(4500);
    }
    sendJson({ t: 'status', state: 'ACTIVE' });
    stream.on('data', (d) => ws.readyState === ws.OPEN && ws.send(Buffer.concat([Buffer.from([0x01]), d])));
    stream.stderr.on('data', (d) => ws.readyState === ws.OPEN && ws.send(Buffer.concat([Buffer.from([0x01]), d])));
    stream.on('close', (code, signal) => {
      sendJson({ t: 'exit', code: code ?? null, signal: signal ?? null });
      ws.close(1000);
      client.end();
    });
    handle = (data, isBinary) => {
      if (isBinary) {
        if (data[0] === 0x00) stream.write(data.subarray(1));
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.t === 'resize') stream.setWindow(msg.rows, msg.cols, 0, 0);
      else if (msg.t === 'signal' && msg.signal === 'SIGINT') stream.write('\x03'); // S4: through the PTY
      else if (msg.t === 'close') stream.end();
    };
    for (const [data, isBinary] of pending.splice(0)) handle(data, isBinary);
    ws.on('close', () => client.end());
  });
}

server.listen(PORT, '127.0.0.1', () => log(`S3 stub broker on http://127.0.0.1:${PORT} → ${TARGET.username}@${TARGET.host}:${TARGET.port}, root ${REMOTE_ROOT}`));
