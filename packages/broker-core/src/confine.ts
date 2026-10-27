import { posix } from 'node:path';

import { DomainError } from '@qe/domain';

/** Longest requested path accepted (11_TESTING_STRATEGY §6: "very long path (>4096)"). */
export const MAX_PATH_LENGTH = 4096;

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function assertRoot(remoteRoot: string): void {
  if (
    !remoteRoot.startsWith('/') ||
    remoteRoot.includes('\0') ||
    (remoteRoot !== '/' && remoteRoot.endsWith('/')) ||
    posix.normalize(remoteRoot) !== remoteRoot
  ) {
    throw new DomainError('INVALID_REQUEST', 'remote root must be an absolute, normalized path');
  }
}

/**
 * Lexical confinement (08_REMOTE_CONNECTIVITY_DESIGN §8): resolves a path the IDE sent, relative to the target's
 * `remoteRoot`, to an absolute path inside it. Refuses NUL, absolute paths, drive letters and anything that
 * escapes after normalization. Backslashes count as separators, so Windows-style traversal is caught too.
 * The result never contains `.` or `..` segments, so the server never resolves `..` after a symlink.
 * This is only the first layer: `PathGuard` also checks where the server says the path really is.
 */
export function confine(remoteRoot: string, requested: string): string {
  assertRoot(remoteRoot);
  if (requested.length > MAX_PATH_LENGTH) throw new DomainError('INVALID_REQUEST', 'path too long');
  if (requested.includes('\0')) throw new DomainError('PATH_OUTSIDE_ROOT');
  const slashed = requested.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) throw new DomainError('PATH_OUTSIDE_ROOT');
  const joined = posix.normalize(posix.join(remoteRoot, slashed));
  const resolved = joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined;
  if (!isInside(remoteRoot, resolved)) throw new DomainError('PATH_OUTSIDE_ROOT');
  return resolved;
}

/** The path of `absolute` relative to `remoteRoot` (`''` for the root itself), for responses and audit. */
export function relativeToRoot(remoteRoot: string, absolute: string): string {
  if (!isInside(remoteRoot, absolute)) throw new DomainError('PATH_OUTSIDE_ROOT');
  if (absolute === remoteRoot) return '';
  return absolute.slice(remoteRoot.endsWith('/') ? remoteRoot.length : remoteRoot.length + 1);
}

/** Asks the remote server for the canonical path (SFTP `realpath`); rejects when the path does not exist. */
export type RealpathFn = (path: string) => Promise<string>;

/**
 * - `follow`: the path must exist; every symlink, including the last component, is resolved (read, list, stat).
 * - `entry`: the last component is not followed and need not exist; its parent must (create, write, mkdir,
 *   rename, delete act on the directory entry itself, never on what a symlink points to).
 */
export type ResolveMode = 'follow' | 'entry';

export interface PathGuard {
  /** Lexical then physical confinement. Call it for every operation: symlinks can change between calls. */
  resolve(requested: string, mode: ResolveMode): Promise<string>;
}

/**
 * Physical confinement (PHASE_09 §9.1): what the server resolves must equal `realpath(remoteRoot)` or lie under
 * it. `realpath(remoteRoot)` is cached for the guard's life (one files-session); everything else is asked again
 * on every call.
 */
export function createPathGuard(remoteRoot: string, realpath: RealpathFn): PathGuard {
  assertRoot(remoteRoot);
  let realRoot: Promise<string> | undefined;

  const canonical = async (path: string): Promise<string> => {
    const real = await realpath(path);
    if (!real.startsWith('/') || real.includes('\0')) throw new DomainError('PATH_OUTSIDE_ROOT');
    return posix.normalize(real);
  };

  const root = (): Promise<string> => {
    realRoot ??= canonical(remoteRoot).catch((error: unknown) => {
      realRoot = undefined;
      throw error;
    });
    return realRoot;
  };

  return {
    async resolve(requested, mode) {
      const lexical = confine(remoteRoot, requested);
      const physicalRoot = await root();
      if (mode === 'follow') {
        const real = await canonical(lexical);
        if (!isInside(physicalRoot, real)) throw new DomainError('PATH_OUTSIDE_ROOT');
        return real;
      }
      if (lexical === remoteRoot) {
        throw new DomainError(
          'INVALID_REQUEST',
          'the remote root itself cannot be created, renamed or deleted',
        );
      }
      const parent = await canonical(posix.dirname(lexical));
      if (!isInside(physicalRoot, parent)) throw new DomainError('PATH_OUTSIDE_ROOT');
      return posix.join(parent, posix.basename(lexical));
    },
  };
}
