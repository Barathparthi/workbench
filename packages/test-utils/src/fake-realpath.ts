import { posix } from 'node:path';

/**
 * realpath(3) over an in-memory tree: `existing` lists the real paths, `links` maps a symlink's path to its target
 * (absolute, or relative to the link's directory). Missing paths reject with `code: 'ENOENT'`, loops with `ELOOP`.
 */
export function fakeRealpath(
  links: Readonly<Record<string, string>>,
  existing: Iterable<string>,
): (path: string) => Promise<string> {
  const exists = new Set(existing);
  const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
  return (path) => {
    const parts = path.split('/').filter(Boolean);
    let current = '/';
    let hops = 0;
    while (parts.length > 0) {
      const next = posix.join(current, parts.shift() ?? '');
      const target = links[next];
      if (target !== undefined) {
        if (++hops > 40) return fail('ELOOP');
        parts.unshift(...target.split('/').filter(Boolean));
        if (target.startsWith('/')) current = '/';
        continue;
      }
      if (next !== '/' && !exists.has(next)) return fail('ENOENT');
      current = next;
    }
    return Promise.resolve(current);
  };
}
