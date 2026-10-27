import URI from '@theia/core/lib/common/uri';
import type { FileChange } from '@theia/filesystem/lib/common/files';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteWatcher, type WatchSource } from '../remote-watcher';

const ROOT = new URI('qe-ssh://0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f/');
const at = (path: string) => ROOT.resolve(path);
const OPTIONS = { fileIntervalMs: 5_000, dirIntervalMs: 10_000, maxTracked: 3 };

/** The "server": file ETags and folder listings by URI string; anything missing does not exist. */
let etags: Map<string, string>;
let listings: Map<string, Map<string, string>>;
let failing: boolean;
let active: boolean;
let fired: FileChange[];
const asked: string[] = [];

const source: WatchSource = {
  fileEtag: (uri) => {
    asked.push(`stat ${uri.path.toString()}`);
    return failing ? Promise.reject(new Error('down')) : Promise.resolve(etags.get(uri.toString()));
  },
  listing: (uri) => {
    asked.push(`list ${uri.path.toString()}`);
    return failing ? Promise.reject(new Error('down')) : Promise.resolve(listings.get(uri.toString()));
  },
};
const watcher = () =>
  new RemoteWatcher(
    source,
    (changes) => fired.push(...changes),
    () => active,
    OPTIONS,
  );
const events = () =>
  fired.map((c) => `${['UPDATED', 'ADDED', 'DELETED'][c.type] ?? '?'} ${c.resource.path.toString()}`);

beforeEach(() => {
  vi.useFakeTimers();
  etags = new Map();
  listings = new Map();
  failing = false;
  active = true;
  fired = [];
  asked.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('remote polling watcher', () => {
  it('reports a change made on the server to a file the IDE has open', async () => {
    const w = watcher();
    w.watch(ROOT, true);
    w.noteFile(at('src/main.py'), '1-9');
    etags.set(at('src/main.py').toString(), '1-9');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toEqual([]);
    etags.set(at('src/main.py').toString(), '7-12');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events()).toEqual(['UPDATED /src/main.py']);
  });

  it('does not report the IDE’s own save', async () => {
    const w = watcher();
    w.watch(ROOT, true);
    w.noteFile(at('a.txt'), '1-1');
    etags.set(at('a.txt').toString(), '2-5');
    w.noteFile(at('a.txt'), '2-5'); // the provider notes its own write
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toEqual([]);
  });

  it('reports a deleted file once and stops polling it', async () => {
    const w = watcher();
    w.watch(ROOT, true);
    w.noteFile(at('gone.txt'), '1-1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events()).toEqual(['DELETED /gone.txt']);
    expect(asked.filter((a) => a === 'stat /gone.txt')).toHaveLength(1);
  });

  it('reports what was added, removed and changed in an expanded folder', async () => {
    const w = watcher();
    w.watch(ROOT, true);
    w.noteDir(
      at('src'),
      new Map([
        ['a.py', 'file:1:1'],
        ['b.py', 'file:1:1'],
      ]),
    );
    listings.set(
      at('src').toString(),
      new Map([
        ['a.py', 'file:2:3'],
        ['c.py', 'file:1:1'],
      ]),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events().sort()).toEqual(['ADDED /src/c.py', 'DELETED /src/b.py', 'UPDATED /src/a.py']);
  });

  it('polls only what a watch covers', async () => {
    const w = watcher();
    w.watch(at('src'), true);
    w.noteFile(at('src/in.py'), '1-1');
    w.noteFile(at('out.py'), '1-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(asked).toEqual(['stat /src/in.py']);
  });

  it('polls a file watched on its own from the start, without a first event', async () => {
    const w = watcher();
    w.watch(at('notes.txt'), false);
    etags.set(at('notes.txt').toString(), '1-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toEqual([]);
    etags.set(at('notes.txt').toString(), '2-2');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events()).toEqual(['UPDATED /notes.txt']);
  });

  it('polls only the most recently used files', async () => {
    const w = watcher();
    w.watch(ROOT, true);
    for (const name of ['1', '2', '3', '4', '5']) {
      etags.set(at(name).toString(), '1-1');
      w.noteFile(at(name), '1-1');
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(asked).toEqual(['stat /3', 'stat /4', 'stat /5']);
  });

  it('pauses while the user is away and resumes when they return', async () => {
    const w = watcher();
    w.watch(ROOT, true);
    w.noteFile(at('a.txt'), '1-1');
    etags.set(at('a.txt').toString(), '1-1');
    active = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toEqual([]);
    active = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(asked).toEqual(['stat /a.txt']);
  });

  it('skips a round when the server cannot be reached, without reporting anything', async () => {
    const w = watcher();
    w.watch(ROOT, true);
    w.noteFile(at('a.txt'), '1-1');
    w.noteDir(at(''), new Map());
    failing = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fired).toEqual([]);
    failing = false;
    etags.set(at('a.txt').toString(), '1-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toEqual([]);
  });

  it('stops polling when the last watch is disposed, and forgets deleted paths', async () => {
    const w = watcher();
    const watch = w.watch(ROOT, true);
    w.noteFile(at('dir/a.txt'), '1-1');
    w.noteDir(at('dir'), new Map());
    w.forget(at('dir'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toEqual([]);
    w.noteFile(at('b.txt'), '1-1');
    watch.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(asked).toEqual([]);
  });
});
