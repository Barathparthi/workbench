/**
 * Traversal corpus (01_ARCHITECTURE/11_TESTING_STRATEGY §6) against remote-file path confinement.
 * Expected: PATH_OUTSIDE_ROOT (or INVALID_REQUEST), never a normalized escaped path. A few entries are legal
 * names once taken literally (no URL decoding, no Unicode folding); those must resolve to a path inside the root,
 * and the list below says exactly which.
 * The same corpus runs against a real OpenSSH server with the SFTP operations (Phase 09 P09.2).
 */
import { describe, expect, it } from 'vitest';

import { confine, createPathGuard, MAX_PATH_LENGTH } from '@qe/broker-core';
import { DomainError } from '@qe/domain';
import { fakeRealpath } from '@qe/test-utils';

const ROOT = '/home/qe/work';
const REFUSED = ['PATH_OUTSIDE_ROOT', 'INVALID_REQUEST'];

/**
 * - `refused`: every layer refuses.
 * - `inside`: a legal path inside the root.
 * - `link`: a symlink that leaves the root; following it is refused, but the link's own entry (to delete or rename
 *   it) is inside the root.
 */
type Expectation = { refused: true } | { inside: string } | { link: string };

const corpus: readonly (readonly [string, Expectation])[] = [
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

const links = {
  [`${ROOT}/symlink-to-etc`]: '/etc',
  [`${ROOT}/dir/symlink-to-parent`]: '..',
  [`${ROOT}/dir/symlink-to-etc-relative`]: '../../../../etc',
  [`${ROOT}/root-sibling-link`]: '../work2',
};
const existing = [
  '/etc',
  '/etc/passwd',
  '/home',
  '/home/qe',
  ROOT,
  `${ROOT}/dir`,
  `${ROOT}/%2e%2e`,
  `${ROOT}/%2e%2e/%2e%2e`,
  `${ROOT}/%2e%2e/%2e%2e/etc`,
  `${ROOT}/%2e%2e/%2e%2e/etc/passwd`,
  `${ROOT}/..%2f..%2fetc`,
  `${ROOT}/....`,
  `${ROOT}/..../....`,
  `${ROOT}/..../..../etc`,
  `${ROOT}/\u2025`,
  `${ROOT}/\u2025/etc`,
  `${ROOT}/\u2025/etc/passwd`,
  '/home/qe/work2',
  '/home/qe/work2/secret',
];

async function outcome(work: () => Promise<string> | string): Promise<string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
}

function label(requested: string): string {
  return requested.length > 60
    ? `${requested.slice(0, 20)}… (${String(requested.length)} chars)`
    : JSON.stringify(requested);
}

describe.each(corpus.map(([requested, expected]) => ({ requested, expected, name: label(requested) })))(
  'traversal corpus: $name',
  ({ requested, expected }) => {
    const isInside = (path: string) => path === ROOT || path.startsWith(`${ROOT}/`);

    it('lexical confine() never returns an escaped path', async () => {
      const result = await outcome(() => confine(ROOT, requested));
      if (REFUSED.includes(result)) return;
      expect(isInside(result), result).toBe(true);
      expect(result.split('/')).not.toContain('..');
      if ('inside' in expected) expect(result).toBe(expected.inside);
    });

    it.each(['follow', 'entry'] as const)('PathGuard (%s) refuses or stays inside the root', async (mode) => {
      const guard = createPathGuard(ROOT, fakeRealpath(links, existing));
      const result = await outcome(() => guard.resolve(requested, mode));
      if ('refused' in expected) {
        expect(REFUSED).toContain(result);
        return;
      }
      if ('link' in expected) {
        if (mode === 'follow') expect(REFUSED).toContain(result);
        else expect(result).toBe(expected.link);
        return;
      }
      if (mode === 'entry' && expected.inside === ROOT) {
        expect(result).toBe('INVALID_REQUEST');
        return;
      }
      expect(result).toBe(expected.inside);
    });
  },
);
