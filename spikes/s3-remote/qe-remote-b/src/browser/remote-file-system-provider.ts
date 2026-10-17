import { Disposable, Emitter, Event } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import {
  FileChange,
  FileChangeType,
  FileDeleteOptions,
  FileOverwriteOptions,
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  FileSystemProviderWithFileReadWriteCapability,
  FileType,
  FileWriteOptions,
  Stat,
  WatchOptions,
  createFileSystemProviderError,
} from '@theia/filesystem/lib/common/files';

import { BrokerError, fromBase64, fsCall, openSession, toBase64 } from './broker-client';

export const REMOTE_SCHEME_B = 'qe-ssh-b';

/** `qe-ssh-b://<targetId>/<path relative to remoteRoot>` backed by the broker's files session. */
export class RemoteFileSystemProvider implements FileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;
  readonly onFileWatchError = Event.None;
  private readonly changes = new Emitter<readonly FileChange[]>();
  readonly onDidChangeFile = this.changes.event;
  private session?: Promise<string>;

  private sessionId(): Promise<string> {
    this.session ??= openSession('files').then((s) => s.sessionId);
    return this.session;
  }

  private async call<T>(op: string, body: object): Promise<T> {
    try {
      return await fsCall<T>(await this.sessionId(), op, body);
    } catch (e) {
      if (e instanceof BrokerError && e.status === 404) throw createFileSystemProviderError(e.code, FileSystemProviderErrorCode.FileNotFound);
      if (e instanceof BrokerError && e.status === 403) throw createFileSystemProviderError(e.code, FileSystemProviderErrorCode.NoPermissions);
      throw e;
    }
  }

  private rel = (uri: URI) => uri.path.toString().replace(/^\/+/, '');

  watch(_resource: URI, _opts: WatchOptions): Disposable {
    return Disposable.NULL; // the spike does not watch remote files
  }

  async stat(resource: URI): Promise<Stat> {
    const s = await this.call<{ type: string; size: number; mtimeMs: number }>('stat', { path: this.rel(resource) });
    return { type: s.type === 'directory' ? FileType.Directory : FileType.File, size: s.size, mtime: s.mtimeMs, ctime: s.mtimeMs };
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const r = await this.call<{ entries: { name: string; type: string }[] }>('list', { path: this.rel(resource) });
    return r.entries.map((e) => [e.name, e.type === 'directory' ? FileType.Directory : FileType.File]);
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const r = await this.call<{ contentBase64: string }>('read', { path: this.rel(resource) });
    return fromBase64(r.contentBase64);
  }

  async writeFile(resource: URI, content: Uint8Array, _opts: FileWriteOptions): Promise<void> {
    await this.call('write', { path: this.rel(resource), contentBase64: toBase64(content) });
    this.changes.fire([{ resource, type: FileChangeType.UPDATED }]);
  }

  async mkdir(resource: URI): Promise<void> {
    await this.call('mkdir', { path: this.rel(resource) });
  }

  async delete(resource: URI, _opts: FileDeleteOptions): Promise<void> {
    await this.call('delete', { path: this.rel(resource) });
  }

  async rename(from: URI, to: URI, _opts: FileOverwriteOptions): Promise<void> {
    await this.call('rename', { from: this.rel(from), to: this.rel(to) });
  }
}
