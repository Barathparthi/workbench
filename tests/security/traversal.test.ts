/**
 * Traversal corpus against remote-file confinement, in memory: lexical `confine()`, the realpath `PathGuard`, and
 * every file operation against a fake SFTP server. The same corpus runs against real OpenSSH in
 * `traversal.int.test.ts`.
 */
import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import { confine, createPathGuard, createRemoteFileSystem, wrapSftp } from '@qe/broker-core';
import { FakeSftp, fakeRealpath } from '@qe/test-utils';

import {
  ACCEPTABLE,
  corpus,
  label,
  operations,
  outcome,
  OUTSIDE,
  REFUSED,
  ROOT,
  SIBLING,
  tree,
} from './traversal-corpus.js';

function withAncestors(paths: Iterable<string>): string[] {
  const all = new Set<string>();
  for (let path of paths) {
    while (path !== '/') {
      all.add(path);
      path = posix.dirname(path);
    }
  }
  return [...all];
}

function fakeServer(): FakeSftp {
  const server = new FakeSftp();
  for (const dir of tree.dirs) server.mkdirp(dir);
  for (const [path, content] of Object.entries(tree.files)) server.put(path, content);
  for (const [path, target] of Object.entries(tree.links)) server.link(path, target);
  return server;
}

const isInside = (path: string) => path === ROOT || path.startsWith(`${ROOT}/`);
const outsideState = (server: FakeSftp) =>
  server
    .paths()
    .filter(
      (p) => p.startsWith(`${OUTSIDE}/`) || p === OUTSIDE || p.startsWith(`${SIBLING}/`) || p === SIBLING,
    )
    .map((p) => `${p}=${server.content(p) ?? ''}`);

describe.each(corpus.map(([requested, expected]) => ({ requested, expected, name: label(requested) })))(
  'traversal corpus: $name',
  ({ requested, expected }) => {
    it('lexical confine() never returns an escaped path', async () => {
      let result = '';
      const code = await outcome(() => Promise.resolve((result = confine(ROOT, requested))));
      if (REFUSED.includes(code)) return;
      expect(isInside(result), result).toBe(true);
      expect(result.split('/')).not.toContain('..');
      if ('inside' in expected) expect(result).toBe(expected.inside);
    });

    it.each(['follow', 'entry'] as const)('PathGuard (%s) refuses or stays inside the root', async (mode) => {
      const guard = createPathGuard(
        ROOT,
        fakeRealpath(tree.links, withAncestors([...tree.dirs, ...Object.keys(tree.files)])),
      );
      let result = '';
      const code = await outcome(async () => {
        result = await guard.resolve(requested, mode);
      });
      if ('refused' in expected) {
        expect(REFUSED).toContain(code);
        return;
      }
      if ('link' in expected) {
        if (mode === 'follow') expect(REFUSED).toContain(code);
        else expect(result).toBe(expected.link);
        return;
      }
      if (mode === 'entry' && expected.inside === ROOT) {
        expect(code).toBe('INVALID_REQUEST');
        return;
      }
      expect(result).toBe(expected.inside);
    });

    it('no file operation sends the server a path outside the root or changes anything there', async () => {
      const server = fakeServer();
      const before = outsideState(server);
      const fs = createRemoteFileSystem(wrapSftp(server as unknown as Parameters<typeof wrapSftp>[0]), {
        remoteRoot: ROOT,
        canWrite: true,
      });
      for (const [name, run] of operations(fs, requested)) {
        const code = await outcome(run);
        expect(ACCEPTABLE.has(code), `${name} → ${code}`).toBe(true);
      }
      const escaped = server.calls.flatMap((call) =>
        call
          .split(' ')
          .slice(1)
          .filter((arg) => arg.startsWith('/') && !isInside(arg)),
      );
      expect(escaped).toEqual([]);
      expect(outsideState(server)).toEqual(before);
    });
  },
);
