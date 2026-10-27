/**
 * Traversal corpus (01_ARCHITECTURE/11_TESTING_STRATEGY §6) and the remote tree it runs against, shared by the
 * in-memory suite (`traversal.test.ts`) and the real OpenSSH suite (`traversal.int.test.ts`).
 *
 * Expected: PATH_OUTSIDE_ROOT (or INVALID_REQUEST), never a normalized escaped path. A few entries are legal names
 * once taken literally (no URL decoding, no Unicode folding); those resolve inside the root, and the list says
 * exactly where. The corpus's "etc" links point at `OUTSIDE`, a directory the remote account CAN write: on a real
 * server only confinement, not Unix permissions, keeps the canaries there intact.
 */
import { MAX_PATH_LENGTH, type RemoteFileSystem } from '@qe/broker-core';
import { DomainError } from '@qe/domain';

export const ROOT = '/home/qe/work';
export const OUTSIDE = '/home/qe/outside';
export const SIBLING = '/home/qe/work2';
export const REFUSED: readonly string[] = ['PATH_OUTSIDE_ROOT', 'INVALID_REQUEST'];

/**
 * - `refused`: every layer refuses.
 * - `inside`: a legal path inside the root.
 * - `link`: a symlink that leaves the root; following it is refused, but the link's own entry (to delete or rename
 *   it) is inside the root.
 */
export type Expectation = { refused: true } | { inside: string } | { link: string };

export const corpus: readonly (readonly [string, Expectation])[] = [
  ['../etc/passwd', { refused: true }],
  ['..\\..\\windows\\win.ini', { refused: true }],
  // Paths arrive as JSON strings and are never URL-decoded: these are odd but legal file names.
  ['%2e%2e/%2e%2e/etc/passwd', { inside: `${ROOT}/%2e%2e/%2e%2e/etc/passwd` }],
  ['..%2f..%2fetc', { inside: `${ROOT}/..%2f..%2fetc` }],
  ['/etc/passwd', { refused: true }],
  ['C:\\Windows\\win.ini', { refused: true }],
  ['foo/../../bar', { refused: true }],
  ['foo/./../..', { refused: true }],
  ['./....//....//etc', { inside: `${ROOT}/..../..../etc` }],
  ['symlink-to-etc/passwd', { refused: true }],
  ['dir/symlink-to-parent/..', { inside: `${ROOT}/dir` }],
  ['name-with-\0-null', { refused: true }],
  ['a/'.repeat(MAX_PATH_LENGTH), { refused: true }],
  // U+2025 TWO DOT LEADER is not "..": no Unicode folding happens anywhere on the path.
  ['\u2025/etc/passwd', { inside: `${ROOT}/\u2025/etc/passwd` }],
  ['trailing-dot-segment/..', { inside: ROOT }],
  // Variants of the excerpt.
  ['..', { refused: true }],
  ['../', { refused: true }],
  ['..\\', { refused: true }],
  ['\\\\server\\share\\x', { refused: true }],
  ['c:', { refused: true }],
  ['symlink-to-etc', { link: `${ROOT}/symlink-to-etc` }],
  ['dir/symlink-to-etc-relative/passwd', { refused: true }],
  ['root-sibling-link/secret', { refused: true }],
  ['../work2/secret', { refused: true }],
];

/** The remote tree: directories, files (with content) and symlinks (with targets). */
export const tree = {
  dirs: [
    ROOT,
    `${ROOT}/dir`,
    `${ROOT}/trailing-dot-segment`,
    `${ROOT}/%2e%2e/%2e%2e/etc`,
    `${ROOT}/..../..../etc`,
    `${ROOT}/\u2025/etc`,
    OUTSIDE,
    SIBLING,
  ],
  files: {
    [`${ROOT}/%2e%2e/%2e%2e/etc/passwd`]: 'inside\n',
    [`${ROOT}/..%2f..%2fetc`]: 'inside\n',
    [`${ROOT}/\u2025/etc/passwd`]: 'inside\n',
    [`${OUTSIDE}/passwd`]: 'canary\n',
    [`${SIBLING}/secret`]: 'canary\n',
  } as Readonly<Record<string, string>>,
  links: {
    [`${ROOT}/symlink-to-etc`]: OUTSIDE,
    [`${ROOT}/dir/symlink-to-parent`]: '..',
    [`${ROOT}/dir/symlink-to-etc-relative`]: '../../outside',
    [`${ROOT}/root-sibling-link`]: '../work2',
  } as Readonly<Record<string, string>>,
};

export function label(requested: string): string {
  return requested.length > 60
    ? `${requested.slice(0, 20)}… (${String(requested.length)} chars)`
    : JSON.stringify(requested);
}

/** The DomainError code, or `ok`. */
export async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
}

/**
 * Every file operation with the corpus path in each path position. Results are not asserted here: what matters is
 * that nothing outside the root changes, which the suites check afterwards.
 */
export function operations(fs: RemoteFileSystem, path: string): [string, () => Promise<unknown>][] {
  const data = Buffer.from('pwned\n');
  return [
    ['stat', () => fs.stat({ path })],
    ['list', () => fs.list({ path })],
    ['read', () => fs.read({ path })],
    ['write', () => fs.write({ path, data })],
    ['write into', () => fs.write({ path: `${path}/new`, data })],
    ['mkdir', () => fs.mkdir({ path: `${path}/made`, recursive: true })],
    [
      'rename to',
      () =>
        fs
          .write({ path: 'scratch', data })
          .then(() => fs.rename({ from: 'scratch', to: path, overwrite: true })),
    ],
    ['rename from', () => fs.rename({ from: path, to: 'moved', overwrite: true })],
    ['delete', () => fs.delete({ path, recursive: true })],
  ];
}

/** Codes an operation may end with. Anything else (an unexpected error) fails the suite. */
export const ACCEPTABLE = new Set(['ok', ...REFUSED, 'NOT_FOUND', 'CONFLICT']);
