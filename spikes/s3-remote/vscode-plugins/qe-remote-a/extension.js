// Spike S3 option A: the same remote terminal + remote files, written against the public VS Code API and
// shipped as a web extension ("browser" entry only), so Theia runs it in the frontend plugin worker.
// Plain JS, no build step. Theia's frontend loader provides `exports` and `require('vscode')`.
const vscode = require('vscode');

const BROKER = 'http://127.0.0.1:8082';
const TARGET_ID = 'tg_lab1';
const SCHEME = 'qe-ssh-a';

async function openSession(kind, terminal) {
  const res = await fetch(`${BROKER}/api/v1/targets/${TARGET_ID}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, terminal }),
  });
  if (!res.ok) throw new Error(`session failed: ${res.status}`);
  return res.json();
}

const toBase64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

class RemoteFileSystem {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
  }
  session() {
    this.sessionPromise ??= openSession('files').then((s) => s.sessionId);
    return this.sessionPromise;
  }
  async call(op, body, uri) {
    const res = await fetch(`${BROKER}/api/v1/sessions/${await this.session()}/fs/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.status === 404) throw vscode.FileSystemError.FileNotFound(uri);
    if (res.status === 403) throw vscode.FileSystemError.NoPermissions(uri);
    if (!res.ok) throw new Error(json.code);
    return json;
  }
  rel(uri) {
    return uri.path.replace(/^\/+/, '');
  }
  watch() {
    return new vscode.Disposable(() => undefined);
  }
  async stat(uri) {
    const s = await this.call('stat', { path: this.rel(uri) }, uri);
    return { type: s.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File, size: s.size, mtime: s.mtimeMs, ctime: s.mtimeMs };
  }
  async readDirectory(uri) {
    const r = await this.call('list', { path: this.rel(uri) }, uri);
    return r.entries.map((e) => [e.name, e.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File]);
  }
  async readFile(uri) {
    return fromBase64((await this.call('read', { path: this.rel(uri) }, uri)).contentBase64);
  }
  async writeFile(uri, content) {
    await this.call('write', { path: this.rel(uri), contentBase64: toBase64(content) }, uri);
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
  async createDirectory(uri) {
    await this.call('mkdir', { path: this.rel(uri) }, uri);
  }
  async delete(uri) {
    await this.call('delete', { path: this.rel(uri) }, uri);
  }
  async rename(oldUri, newUri) {
    await this.call('rename', { from: this.rel(oldUri), to: this.rel(newUri) }, oldUri);
  }
}

function remoteTerminal() {
  const write = new vscode.EventEmitter();
  const close = new vscode.EventEmitter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const queue = [];
  let ws;
  const sendRaw = (frame) => (ws && ws.readyState === WebSocket.OPEN ? ws.send(frame) : queue.push(frame));
  const pty = {
    onDidWrite: write.event,
    onDidClose: close.event,
    async open(dims) {
      const session = await openSession('terminal', dims ? { cols: dims.columns, rows: dims.rows } : undefined);
      ws = new WebSocket(`${BROKER.replace(/^http/, 'ws')}${session.streamUrl}`, ['qews.v1', `ticket.${session.ticket}`]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => queue.splice(0).forEach((f) => ws.send(f));
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          if (JSON.parse(e.data).t === 'exit') close.fire();
          return;
        }
        const bytes = new Uint8Array(e.data);
        if (bytes[0] === 0x01) write.fire(decoder.decode(bytes.subarray(1), { stream: true }));
      };
    },
    close() {
      if (ws) ws.close(1000);
    },
    handleInput(data) {
      const bytes = encoder.encode(data);
      const frame = new Uint8Array(bytes.length + 1);
      frame.set(bytes, 1);
      sendRaw(frame);
    },
    setDimensions(dims) {
      sendRaw(JSON.stringify({ t: 'resize', cols: dims.columns, rows: dims.rows }));
    },
  };
  return pty;
}

exports.activate = function activate(context) {
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, new RemoteFileSystem(), { isCaseSensitive: true }),
    vscode.commands.registerCommand('qe.remoteA.openTerminal', () => {
      vscode.window.createTerminal({ name: `qe-ssh ${TARGET_ID} (A)`, pty: remoteTerminal() }).show();
    }),
    vscode.commands.registerCommand('qe.remoteA.openFile', () =>
      vscode.window.showTextDocument(vscode.Uri.parse(`${SCHEME}://${TARGET_ID}/hello.txt`)),
    ),
    vscode.commands.registerCommand('qe.remoteA.webview', () => {
      const panel = vscode.window.createWebviewPanel('qeWebview', 'QE Webview', vscode.ViewColumn.One, {});
      panel.webview.html = '<!doctype html><html><body><h1 id="qe-webview-ok">QE webview OK</h1></body></html>';
    }),
  );
};
