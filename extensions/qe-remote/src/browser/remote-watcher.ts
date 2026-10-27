import { Disposable } from '@theia/core/lib/common';
import type URI from '@theia/core/lib/common/uri';
import type { FileChange, FileChangeType } from '@theia/filesystem/lib/common/files';

/* eslint-disable @typescript-eslint/no-unsafe-enum-assignment --
   FileChangeType is an ambient const enum (no runtime object); its values are spelled out. */
const UPDATED = 0 as FileChangeType;
const ADDED = 1 as FileChangeType;
const DELETED = 2 as FileChangeType;
/* eslint-enable @typescript-eslint/no-unsafe-enum-assignment */

export interface RemoteWatcherOptions {
  /** Open files (PHASE_09 §9.5: 5 s). */
  readonly fileIntervalMs: number;
  /** Expanded folders (§9.5: 10 s). */
  readonly dirIntervalMs: number;
  /** How many of the most recently read files and listed folders are polled. */
  readonly maxTracked: number;
}

export const DEFAULT_WATCHER_OPTIONS: RemoteWatcherOptions = {
  fileIntervalMs: 5_000,
  dirIntervalMs: 10_000,
  maxTracked: 20,
};

/** What the watcher asks the server, without the provider's side effects. Errors mean "skip this round". */
export interface WatchSource {
  /** The file's ETag, or undefined when it no longer exists. */
  fileEtag(uri: URI): Promise<string | undefined>;
  /** Each entry's `type:mtime:size`, or undefined when the folder no longer exists. */
  listing(uri: URI): Promise<ReadonlyMap<string, string> | undefined>;
}

/**
 * Polling watcher for `qe-ssh://` (PHASE_09 §9.5; no agents on remote systems in v1). Theia watches a workspace root
 * recursively and folds the watches of open editors into it, so the provider never hears which files are open. The
 * watcher therefore polls what the IDE has used: the files it read (open editors) and the folders it listed
 * (expanded in the Explorer), the most recent `maxTracked` of each, while a watch covers them. Polling stops while
 * `isActive` says the user is away, so the files-session can reach its idle timeout; it resumes, and a closed session
 * is replaced, with the user's next action.
 */
export class RemoteWatcher {
  protected readonly watches = new Map<number, { uri: URI; recursive: boolean }>();
  protected readonly files = new Map<string, { uri: URI; etag: string | undefined }>();
  protected readonly dirs = new Map<string, { uri: URI; listing: ReadonlyMap<string, string> | undefined }>();
  protected nextId = 0;
  protected timers: ReturnType<typeof setInterval>[] = [];
  protected busy = { files: false, dirs: false };

  constructor(
    protected readonly source: WatchSource,
    protected readonly fire: (changes: readonly FileChange[]) => void,
    protected readonly isActive: () => boolean,
    protected readonly options: RemoteWatcherOptions = DEFAULT_WATCHER_OPTIONS,
  ) {}

  watch(uri: URI, recursive: boolean): Disposable {
    const id = this.nextId++;
    this.watches.set(id, { uri, recursive });
    // A file watched on its own (outside any recursive root) is polled from the start.
    if (!recursive && !this.dirs.has(uri.toString())) this.touch(this.files, uri, { uri, etag: undefined });
    if (this.timers.length === 0) {
      this.timers = [
        setInterval(() => void this.pollFiles(), this.options.fileIntervalMs),
        setInterval(() => void this.pollDirs(), this.options.dirIntervalMs),
      ];
    }
    return Disposable.create(() => {
      this.watches.delete(id);
      if (this.watches.size === 0) {
        for (const t of this.timers) clearInterval(t);
        this.timers = [];
      }
    });
  }

  /** The IDE read or wrote this file (an editor has it open): poll it, starting from this ETag. */
  noteFile(uri: URI, etag: string): void {
    this.files.delete(uri.toString()); // re-insert as most recent
    this.touch(this.files, uri, { uri, etag });
  }

  /** A stat saw this ETag: keep a polled file's baseline current without polling more files. */
  updateFile(uri: URI, etag: string): void {
    const entry = this.files.get(uri.toString());
    if (entry !== undefined) entry.etag = etag;
  }

  /** The IDE listed this folder (expanded in the Explorer): poll it, starting from this listing. */
  noteDir(uri: URI, listing: ReadonlyMap<string, string>): void {
    this.dirs.delete(uri.toString());
    this.touch(this.dirs, uri, { uri, listing });
  }

  forget(uri: URI): void {
    for (const map of [this.files, this.dirs] as Map<string, { uri: URI }>[]) {
      for (const [key, entry] of map) if (uri.isEqualOrParent(entry.uri)) map.delete(key);
    }
  }

  protected touch<T>(map: Map<string, T>, uri: URI, value: T): void {
    map.set(uri.toString(), value);
    while (map.size > this.options.maxTracked) map.delete(map.keys().next().value as string);
  }

  protected covered(uri: URI): boolean {
    for (const w of this.watches.values()) {
      if (w.uri.isEqual(uri) || (w.recursive && w.uri.isEqualOrParent(uri))) return true;
    }
    return false;
  }

  async pollFiles(): Promise<void> {
    if (this.busy.files || !this.isActive()) return;
    this.busy.files = true;
    try {
      const changes: FileChange[] = [];
      for (const entry of [...this.files.values()].filter((e) => this.covered(e.uri))) {
        let etag: string | undefined;
        try {
          etag = await this.source.fileEtag(entry.uri);
        } catch {
          continue;
        }
        if (etag === undefined) {
          if (entry.etag !== undefined) changes.push({ resource: entry.uri, type: DELETED });
          this.files.delete(entry.uri.toString());
        } else {
          if (entry.etag !== undefined && entry.etag !== etag)
            changes.push({ resource: entry.uri, type: UPDATED });
          entry.etag = etag;
        }
      }
      if (changes.length > 0) this.fire(changes);
    } finally {
      this.busy.files = false;
    }
  }

  async pollDirs(): Promise<void> {
    if (this.busy.dirs || !this.isActive()) return;
    this.busy.dirs = true;
    try {
      const changes: FileChange[] = [];
      for (const entry of [...this.dirs.values()].filter((e) => this.covered(e.uri))) {
        let listing: ReadonlyMap<string, string> | undefined;
        try {
          listing = await this.source.listing(entry.uri);
        } catch {
          continue;
        }
        if (listing === undefined) {
          changes.push({ resource: entry.uri, type: DELETED });
          this.dirs.delete(entry.uri.toString());
          continue;
        }
        const before = entry.listing ?? new Map<string, string>();
        for (const [name, signature] of listing) {
          const was = before.get(name);
          if (was === undefined) changes.push({ resource: entry.uri.resolve(name), type: ADDED });
          else if (was !== signature) changes.push({ resource: entry.uri.resolve(name), type: UPDATED });
        }
        for (const name of before.keys()) {
          if (!listing.has(name)) changes.push({ resource: entry.uri.resolve(name), type: DELETED });
        }
        entry.listing = listing;
      }
      if (changes.length > 0) this.fire(changes);
    } finally {
      this.busy.dirs = false;
    }
  }
}
