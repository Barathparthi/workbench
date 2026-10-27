import { describe, expect, it } from 'vitest';

import { isRemoteFolder, mapFolders } from '../workspace-folders';

const REMOTE = 'qe-ssh://0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f/';

describe('workspace file folders', () => {
  it('keeps remote roots as absolute URIs and transforms only local ones, in order', () => {
    const seen: string[] = [];
    const folders = mapFolders(
      [{ path: 'file:///home/qe/project' }, { path: REMOTE }, { path: 'file:///home/qe/other' }],
      (folder) => {
        seen.push(folder.path);
        return { path: folder.path.replace('file:///home/qe/', '../') };
      },
    );
    expect(folders).toEqual([{ path: '../project' }, { path: REMOTE }, { path: '../other' }]);
    expect(seen).toEqual(['file:///home/qe/project', 'file:///home/qe/other']);
  });

  it('drops a local root Theia cannot resolve, as Theia does', () => {
    expect(mapFolders([{ path: 'bad' }, { path: REMOTE }], () => undefined)).toEqual([{ path: REMOTE }]);
  });

  it('recognizes only qe-ssh URIs as remote', () => {
    expect(isRemoteFolder(REMOTE)).toBe(true);
    expect(isRemoteFolder('file:///qe-ssh/x')).toBe(false);
    expect(isRemoteFolder('../qe-ssh')).toBe(false);
  });
});
