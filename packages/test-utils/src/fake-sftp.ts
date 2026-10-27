/**
 * An in-memory SFTP server seen through ssh2's client API (the `SFTPWrapper` methods remote files use), with
 * OpenSSH's semantics: realpath resolves every symlink and allows a missing last component, errors carry SFTP v3
 * status codes (2 no such file, 3 permission denied, 4 failure), readdir ends with an EOF status, and
 * `posix-rename@openssh.com` replaces its target. Tests change the tree "on the server" with the helper methods.
 */
import { EventEmitter } from 'node:events';
import { posix } from 'node:path';

type Node =
  | { kind: 'file'; data: Buffer; mode: number; mtime: number }
  | { kind: 'dir'; mode: number; mtime: number }
  | { kind: 'symlink'; target: string; mtime: number };

type Cb<T = undefined> = (error: Error | undefined, value?: T) => void;

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export interface FakeStats {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

function status(code: number): Error {
  return Object.assign(new Error(`SFTP status ${String(code)}`), { code });
}

function statsOf(node: Node): FakeStats {
  const type = node.kind === 'file' ? S_IFREG : node.kind === 'dir' ? S_IFDIR : S_IFLNK;
  const perm = node.kind === 'symlink' ? 0o777 : node.mode;
  const size = node.kind === 'file' ? node.data.length : node.kind === 'symlink' ? node.target.length : 4096;
  return {
    mode: type | perm,
    uid: 1000,
    gid: 1000,
    size,
    atime: node.mtime,
    mtime: node.mtime,
    isFile: () => node.kind === 'file',
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => node.kind === 'symlink',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

export interface FakeSftpOptions {
  /** Offer `posix-rename@openssh.com` (OpenSSH does). Default true. */
  readonly posixRename?: boolean;
}

export class FakeSftp extends EventEmitter {
  /** Clock in whole seconds, like SFTP v3 mtimes. */
  now = 1_761_000_000;
  /** Every client call, in order: `method path…`. */
  readonly calls: string[] = [];
  private readonly nodes = new Map<string, Node>([['/', { kind: 'dir', mode: 0o755, mtime: 1_761_000_000 }]]);
  private readonly handles = new Map<string, { path: string; dir?: boolean; listed?: boolean }>();
  private readonly failures = new Map<string, Error | 'hang'>();
  private readonly denied = new Set<string>();
  private nextHandle = 0;
  private readonly posixRename: boolean;

  constructor(options: FakeSftpOptions = {}) {
    super();
    this.posixRename = options.posixRename ?? true;
  }

  // ---- test helpers: change the server behind the client's back -------------------------------------------

  mkdirp(path: string): this {
    let current = '/';
    for (const part of path.split('/').filter(Boolean)) {
      current = posix.join(current, part);
      if (!this.nodes.has(current)) this.nodes.set(current, { kind: 'dir', mode: 0o755, mtime: this.now });
    }
    return this;
  }

  put(path: string, content: string | Buffer, mode = 0o644): this {
    this.mkdirp(posix.dirname(path));
    this.nodes.set(path, { kind: 'file', data: Buffer.from(content), mode, mtime: this.now });
    return this;
  }

  link(path: string, target: string): this {
    this.mkdirp(posix.dirname(path));
    this.nodes.set(path, { kind: 'symlink', target, mtime: this.now });
    return this;
  }

  remove(path: string): this {
    for (const key of [...this.nodes.keys()])
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
    return this;
  }

  /** What is stored at exactly this path (no symlink resolution). */
  node(path: string): Readonly<Node> | undefined {
    return this.nodes.get(path);
  }

  content(path: string): string | undefined {
    const node = this.nodes.get(path);
    return node?.kind === 'file' ? node.data.toString('utf8') : undefined;
  }

  paths(): string[] {
    return [...this.nodes.keys()].sort();
  }

  /** The next call of `method` fails with this SFTP status (or an Error), or never answers (`'hang'`). */
  failNext(method: string, failure: number | Error | 'hang'): this {
    this.failures.set(method, typeof failure === 'number' ? status(failure) : failure);
    return this;
  }

  /** Mutations under this path fail with "permission denied". */
  deny(path: string): this {
    this.denied.add(path);
    return this;
  }

  // ---- resolution ---------------------------------------------------------------------------------------------

  /** Resolves every symlink; `allowMissingLast` is OpenSSH's realpath. Returns an SFTP status code on failure. */
  private resolve(path: string, allowMissingLast: boolean): string | number {
    const parts = path.split('/').filter(Boolean);
    let current = '/';
    let hops = 0;
    while (parts.length > 0) {
      const part = parts.shift() ?? '';
      if (part === '.') continue;
      const next = posix.join(current, part);
      const node = this.nodes.get(next);
      if (node === undefined) {
        if (allowMissingLast && parts.length === 0) return next;
        return 2;
      }
      if (node.kind === 'symlink') {
        if (++hops > 32) return 4;
        parts.unshift(...node.target.split('/').filter(Boolean));
        if (node.target.startsWith('/')) current = '/';
        continue;
      }
      if (parts.length > 0 && node.kind !== 'dir') return 2;
      current = next;
    }
    return current;
  }

  /** The parent resolved, the last component taken as is (lstat, unlink, rename, mkdir). */
  private entry(path: string): string | number {
    const parent = this.resolve(posix.dirname(path), false);
    if (typeof parent === 'number') return parent;
    if (this.nodes.get(parent)?.kind !== 'dir') return 2;
    return posix.join(parent, posix.basename(path));
  }

  private begin<T>(method: string, args: string[], cb: Cb<T>): boolean {
    this.calls.push([method, ...args].join(' '));
    const failure = this.failures.get(method);
    if (failure === undefined) return true;
    this.failures.delete(method);
    if (failure !== 'hang')
      queueMicrotask(() => {
        cb(failure);
      });
    return false;
  }

  private isDenied(path: string): boolean {
    return [...this.denied].some((d) => path === d || path.startsWith(`${d}/`));
  }

  private answer<T>(cb: Cb<T>, result: T | number): void {
    queueMicrotask(() => {
      if (typeof result === 'number') cb(status(result));
      else cb(undefined, result);
    });
  }

  // ---- the SFTPWrapper surface ------------------------------------------------------------------------------

  realpath(path: string, cb: Cb<string>): void {
    if (!this.begin('realpath', [path], cb)) return;
    this.answer(cb, this.resolve(path.startsWith('/') ? path : `/${path}`, true));
  }

  stat(path: string, cb: Cb<FakeStats>): void {
    if (!this.begin('stat', [path], cb)) return;
    const real = this.resolve(path, false);
    this.answer(cb, typeof real === 'number' ? real : statsOf(this.nodes.get(real) as Node));
  }

  lstat(path: string, cb: Cb<FakeStats>): void {
    if (!this.begin('lstat', [path], cb)) return;
    const at = this.entry(path);
    const node = typeof at === 'string' ? this.nodes.get(at) : undefined;
    this.answer(cb, node === undefined ? 2 : statsOf(node));
  }

  opendir(path: string, cb: Cb<Buffer>): void {
    if (!this.begin('opendir', [path], cb)) return;
    const real = this.resolve(path, false);
    if (typeof real === 'number') {
      this.answer(cb, real);
      return;
    }
    if (this.nodes.get(real)?.kind !== 'dir') {
      this.answer(cb, 4);
      return;
    }
    this.answer(cb, this.open_(real, true));
  }

  readdir(handle: Buffer, cb: Cb<{ filename: string; longname: string; attrs: FakeStats }[]>): void {
    if (!this.begin('readdir', [], cb)) return;
    const h = this.handles.get(handle.toString());
    if (h?.dir !== true) {
      this.answer(cb, 4);
      return;
    }
    if (h.listed === true) {
      this.answer(cb, 1);
      return;
    }
    h.listed = true;
    const prefix = h.path === '/' ? '/' : `${h.path}/`;
    const children = [...this.nodes.entries()]
      .filter(([p]) => p !== h.path && p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, node]) => ({ filename: p.slice(prefix.length), longname: '', attrs: statsOf(node) }));
    this.answer(cb, [
      { filename: '.', longname: '', attrs: statsOf(this.nodes.get(h.path) as Node) },
      ...children,
    ]);
  }

  open(path: string, flags: string, attrs: { mode?: number } | Cb<Buffer>, cb?: Cb<Buffer>): void {
    const done = (typeof attrs === 'function' ? attrs : cb) as Cb<Buffer>;
    if (!this.begin('open', [path, flags], done)) return;
    if (flags === 'r') {
      const real = this.resolve(path, false);
      if (typeof real === 'number') {
        this.answer(done, real);
        return;
      }
      this.answer(done, this.open_(real, false));
      return;
    }
    const at = this.entry(path);
    if (typeof at === 'number') {
      this.answer(done, at);
      return;
    }
    if (this.isDenied(at)) {
      this.answer(done, 3);
      return;
    }
    if (this.nodes.has(at)) {
      this.answer(done, 4);
      return;
    }
    const mode = typeof attrs === 'object' && attrs.mode !== undefined ? attrs.mode : 0o644;
    this.nodes.set(at, { kind: 'file', data: Buffer.alloc(0), mode, mtime: this.now });
    this.answer(done, this.open_(at, false));
  }

  fstat(handle: Buffer, cb: Cb<FakeStats>): void {
    if (!this.begin('fstat', [], cb)) return;
    const node = this.nodeOf(handle);
    this.answer(cb, node === undefined ? 4 : statsOf(node));
  }

  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (error: Error | undefined, bytesRead: number) => void,
  ): void {
    if (
      !this.begin('read', [], (e) => {
        cb(e, 0);
      })
    )
      return;
    const node = this.nodeOf(handle);
    if (node?.kind !== 'file') {
      this.answer((e) => {
        cb(e, 0);
      }, 4);
      return;
    }
    const n = Math.max(0, Math.min(length, node.data.length - position));
    node.data.copy(buffer, offset, position, position + n);
    queueMicrotask(() => {
      cb(undefined, n);
    });
  }

  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, cb: Cb): void {
    if (!this.begin('write', [], cb)) return;
    const node = this.nodeOf(handle);
    if (node?.kind !== 'file') {
      this.answer(cb, 4);
      return;
    }
    const data = Buffer.alloc(Math.max(node.data.length, position + length));
    node.data.copy(data);
    buffer.copy(data, position, offset, offset + length);
    node.data = data;
    node.mtime = this.now;
    this.answer(cb, undefined);
  }

  close(handle: Buffer, cb: Cb): void {
    if (!this.begin('close', [], cb)) return;
    this.handles.delete(handle.toString());
    this.answer(cb, undefined);
  }

  rename(from: string, to: string, cb: Cb): void {
    if (!this.begin('rename', [from, to], cb)) return;
    this.answer(cb, this.move(from, to, false));
  }

  ext_openssh_rename(from: string, to: string, cb: Cb): void {
    if (!this.posixRename) throw new Error('Server does not support this extended request');
    if (!this.begin('posix-rename', [from, to], cb)) return;
    this.answer(cb, this.move(from, to, true));
  }

  mkdir(path: string, cb: Cb): void {
    if (!this.begin('mkdir', [path], cb)) return;
    const at = this.entry(path);
    if (typeof at === 'number') {
      this.answer(cb, at);
      return;
    }
    if (this.isDenied(at)) {
      this.answer(cb, 3);
      return;
    }
    if (this.nodes.has(at)) {
      this.answer(cb, 4);
      return;
    }
    this.nodes.set(at, { kind: 'dir', mode: 0o755, mtime: this.now });
    this.answer(cb, undefined);
  }

  rmdir(path: string, cb: Cb): void {
    if (!this.begin('rmdir', [path], cb)) return;
    const at = this.entry(path);
    if (typeof at === 'number') {
      this.answer(cb, at);
      return;
    }
    const node = this.nodes.get(at);
    if (node === undefined) {
      this.answer(cb, 2);
      return;
    }
    if (this.isDenied(at)) {
      this.answer(cb, 3);
      return;
    }
    if (node.kind !== 'dir' || this.paths().some((p) => p.startsWith(`${at}/`))) {
      this.answer(cb, 4);
      return;
    }
    this.nodes.delete(at);
    this.answer(cb, undefined);
  }

  unlink(path: string, cb: Cb): void {
    if (!this.begin('unlink', [path], cb)) return;
    const at = this.entry(path);
    if (typeof at === 'number') {
      this.answer(cb, at);
      return;
    }
    const node = this.nodes.get(at);
    if (node === undefined) {
      this.answer(cb, 2);
      return;
    }
    if (this.isDenied(at)) {
      this.answer(cb, 3);
      return;
    }
    if (node.kind === 'dir') {
      this.answer(cb, 4);
      return;
    }
    this.nodes.delete(at);
    this.answer(cb, undefined);
  }

  end(): void {
    this.calls.push('end');
    this.emit('close');
  }

  private open_(path: string, dir: boolean): Buffer {
    const id = String(this.nextHandle++);
    this.handles.set(id, { path, dir });
    return Buffer.from(id);
  }

  private nodeOf(handle: Buffer): Node | undefined {
    const h = this.handles.get(handle.toString());
    return h === undefined ? undefined : this.nodes.get(h.path);
  }

  private move(from: string, to: string, replace: boolean): number | undefined {
    const source = this.entry(from);
    const target = this.entry(to);
    if (typeof source === 'number') return source;
    if (typeof target === 'number') return target;
    if (!this.nodes.has(source)) return 2;
    if (this.isDenied(source) || this.isDenied(target)) return 3;
    const existing = this.nodes.get(target);
    if (existing !== undefined && (!replace || existing.kind === 'dir')) return 4;
    if (target.startsWith(`${source}/`)) return 4;
    for (const [p, node] of [...this.nodes.entries()]) {
      if (p === source || p.startsWith(`${source}/`)) {
        this.nodes.delete(p);
        this.nodes.set(target + p.slice(source.length), node);
      }
    }
    return undefined;
  }
}
