import { posix } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DomainError } from '@qe/domain';
import { fakeRealpath } from '@qe/test-utils';

import { confine, createPathGuard, MAX_PATH_LENGTH, relativeToRoot, type RealpathFn } from '../index.js';

const ROOT = '/home/qe/work';

/** The DomainError code, or the errno-style `code` the fake server rejects with. */
async function codeOf(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
    throw error;
  }
  return 'resolved';
}

describe('confine (lexical)', () => {
  it.each([
    ['', ROOT],
    ['.', ROOT],
    ['./', ROOT],
    ['src/main.py', `${ROOT}/src/main.py`],
    ['src//main.py', `${ROOT}/src/main.py`],
    ['src/./main.py', `${ROOT}/src/main.py`],
    ['src/tests/../main.py', `${ROOT}/src/main.py`],
    ['src/', `${ROOT}/src`],
    ['src\\main.py', `${ROOT}/src/main.py`],
    ['a/b/../../c', `${ROOT}/c`],
    // Leaves and re-enters the root: harmless, since only the normalized path ever reaches the server.
    ['a/../../work/x', `${ROOT}/x`],
    ['.hidden', `${ROOT}/.hidden`],
    ['...', `${ROOT}/...`],
    ['name with spaces/ünïcode.txt', `${ROOT}/name with spaces/ünïcode.txt`],
  ])('%j → %s', (requested, expected) => {
    expect(confine(ROOT, requested)).toBe(expected);
  });

  it.each([
    '..',
    '../',
    '../work-other/x',
    'a/../../work2/x',
    '/etc/passwd',
    '\\etc\\passwd',
    '\\\\server\\share',
    'C:\\Windows',
    'c:relative',
    'a\0b',
  ])('refuses %j', (requested) => {
    expect(() => confine(ROOT, requested)).toThrow(expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }));
  });

  it('refuses a sibling directory that shares the root as a prefix', () => {
    expect(() => confine(ROOT, '../work2/secret')).toThrow(
      expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }),
    );
  });

  it('accepts a path of exactly the limit and refuses a longer one', () => {
    const atLimit = 'a/'.repeat(MAX_PATH_LENGTH / 2);
    expect(confine(ROOT, atLimit)).toBe(posix.join(ROOT, atLimit).slice(0, -1));
    expect(() => confine(ROOT, `${atLimit}a`)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it.each(['relative/root', '/home/qe/../etc', '/home/qe/', 'has\0nul'])(
    'refuses the remote root %j',
    (root) => {
      expect(() => confine(root, 'x')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    },
  );

  it('works with / as the root', () => {
    expect(confine('/', 'etc/hosts')).toBe('/etc/hosts');
    expect(confine('/', '../..')).toBe('/');
  });
});

describe('relativeToRoot', () => {
  it('gives the path relative to the root', () => {
    expect(relativeToRoot(ROOT, ROOT)).toBe('');
    expect(relativeToRoot(ROOT, `${ROOT}/src/a.py`)).toBe('src/a.py');
    expect(relativeToRoot('/', '/etc/hosts')).toBe('etc/hosts');
  });

  it('refuses a path outside the root', () => {
    expect(() => relativeToRoot(ROOT, '/home/qe/work2/a')).toThrow(
      expect.objectContaining({ code: 'PATH_OUTSIDE_ROOT' }),
    );
  });
});

describe('createPathGuard (physical)', () => {
  const existing = [
    '/home',
    '/home/qe',
    ROOT,
    `${ROOT}/src`,
    `${ROOT}/src/main.py`,
    '/etc',
    '/etc/passwd',
    '/home/qe/work2',
    '/home/qe/work2/secret',
  ];
  const links = {
    [`${ROOT}/link-to-etc`]: '/etc',
    [`${ROOT}/link-to-src`]: 'src',
    [`${ROOT}/src/link-to-parent`]: '..',
    [`${ROOT}/link-to-sibling`]: '../work2',
    [`${ROOT}/passwd-link`]: '/etc/passwd',
  };
  const guard = () => createPathGuard(ROOT, fakeRealpath(links, existing));

  it.each([
    ['src/main.py', `${ROOT}/src/main.py`],
    ['link-to-src/main.py', `${ROOT}/src/main.py`],
    ['src/link-to-parent', ROOT],
    ['', ROOT],
  ])('follow: %j → %s', async (requested, expected) => {
    await expect(guard().resolve(requested, 'follow')).resolves.toBe(expected);
  });

  it.each(['link-to-etc/passwd', 'link-to-etc', 'passwd-link', 'link-to-sibling/secret'])(
    'follow: refuses %j, which leaves the root through a symlink',
    async (requested) => {
      expect(await codeOf(() => guard().resolve(requested, 'follow'))).toBe('PATH_OUTSIDE_ROOT');
    },
  );

  it('follow: a missing path fails with what realpath says', async () => {
    expect(await codeOf(() => guard().resolve('src/missing.py', 'follow'))).toBe('ENOENT');
  });

  it.each([
    ['src/new.py', `${ROOT}/src/new.py`],
    ['src/main.py', `${ROOT}/src/main.py`],
    ['link-to-src/new.py', `${ROOT}/src/new.py`],
    // The entry itself: deleting or renaming a symlink acts on the link, never on what it points to.
    ['passwd-link', `${ROOT}/passwd-link`],
    ['link-to-etc', `${ROOT}/link-to-etc`],
  ])('entry: %j → %s', async (requested, expected) => {
    await expect(guard().resolve(requested, 'entry')).resolves.toBe(expected);
  });

  it.each(['link-to-etc/new', 'link-to-etc/passwd', 'link-to-sibling/secret'])(
    'entry: refuses %j, whose parent leaves the root',
    async (requested) => {
      expect(await codeOf(() => guard().resolve(requested, 'entry'))).toBe('PATH_OUTSIDE_ROOT');
    },
  );

  it('entry: refuses the root itself', async () => {
    expect(await codeOf(() => guard().resolve('', 'entry'))).toBe('INVALID_REQUEST');
    expect(await codeOf(() => guard().resolve('src/..', 'entry'))).toBe('INVALID_REQUEST');
  });

  it('entry: a missing parent fails with what realpath says', async () => {
    expect(await codeOf(() => guard().resolve('nope/new.py', 'entry'))).toBe('ENOENT');
  });

  it('refuses lexically before asking the server', async () => {
    const realpath = vi.fn<RealpathFn>();
    const g = createPathGuard(ROOT, realpath);
    expect(await codeOf(() => g.resolve('../etc/passwd', 'follow'))).toBe('PATH_OUTSIDE_ROOT');
    expect(realpath).not.toHaveBeenCalled();
  });

  it('compares against the real root when the root itself is a symlink', async () => {
    const realpath = fakeRealpath({ '/home/qe/work': '/data/qe' }, [
      '/home',
      '/home/qe',
      '/data',
      '/data/qe',
      '/data/qe/a.txt',
    ]);
    const g = createPathGuard(ROOT, realpath);
    await expect(g.resolve('a.txt', 'follow')).resolves.toBe('/data/qe/a.txt');
    await expect(g.resolve('b.txt', 'entry')).resolves.toBe('/data/qe/b.txt');
  });

  it('caches the real root but asks again for every path (a symlink swapped between calls is caught)', async () => {
    const swappable: Record<string, string> = {};
    const realpath = vi.fn(fakeRealpath(swappable, [...existing, `${ROOT}/data`, `${ROOT}/data/f`]));
    const g = createPathGuard(ROOT, realpath);
    await expect(g.resolve('data/f', 'follow')).resolves.toBe(`${ROOT}/data/f`);
    swappable[`${ROOT}/data`] = '/etc';
    expect(await codeOf(() => g.resolve('data/passwd', 'follow'))).toBe('PATH_OUTSIDE_ROOT');
    expect(await codeOf(() => g.resolve('data/new', 'entry'))).toBe('PATH_OUTSIDE_ROOT');
    expect(realpath.mock.calls.filter(([p]) => p === ROOT)).toHaveLength(1);
  });

  it('asks for the real root again after a failure', async () => {
    const realpath = vi
      .fn<RealpathFn>()
      .mockRejectedValueOnce(new DomainError('SSH_TIMEOUT'))
      .mockImplementation((p) => Promise.resolve(p));
    const g = createPathGuard(ROOT, realpath);
    expect(await codeOf(() => g.resolve('a', 'follow'))).toBe('SSH_TIMEOUT');
    await expect(g.resolve('a', 'follow')).resolves.toBe(`${ROOT}/a`);
  });

  it.each(['relative/answer', '/home/qe/work/a\0', ''])(
    'refuses a malformed realpath answer %j',
    async (answer) => {
      const g = createPathGuard(ROOT, (p) => Promise.resolve(p === ROOT ? ROOT : answer));
      expect(await codeOf(() => g.resolve('a', 'follow'))).toBe('PATH_OUTSIDE_ROOT');
    },
  );

  it('normalizes the realpath answer before comparing', async () => {
    const g = createPathGuard(ROOT, (p) => Promise.resolve(p === ROOT ? ROOT : `${ROOT}/../../../etc`));
    expect(await codeOf(() => g.resolve('a', 'follow'))).toBe('PATH_OUTSIDE_ROOT');
  });

  it('refuses an invalid remote root up front', () => {
    expect(() => createPathGuard('relative', vi.fn<RealpathFn>())).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });
});
