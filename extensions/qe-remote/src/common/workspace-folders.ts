import { QE_SSH_SCHEME } from './remote-files';

/** A workspace file's folder entry (`{ "path": … }`). */
export interface WorkspaceFolder {
  readonly path: string;
}

/** Theia's per-folder transform for local roots (relative ↔ absolute file paths). */
type Transform = (folder: WorkspaceFolder) => WorkspaceFolder | undefined;

export const isRemoteFolder = (path: string): boolean => path.startsWith(`${QE_SSH_SCHEME}:`);

/**
 * Theia 1.76 stores workspace roots as file paths only: its transforms force the `file` scheme, so a `qe-ssh://`
 * root would be written as a local path and come back as garbage. Remote roots therefore stay absolute URIs in the
 * workspace file, and only local roots go through Theia's own transform, in their original order.
 */
export function mapFolders(folders: readonly WorkspaceFolder[], local: Transform): WorkspaceFolder[] {
  return folders.flatMap((folder) => {
    if (isRemoteFolder(folder.path)) return [{ path: folder.path }];
    const transformed = local(folder);
    return transformed === undefined ? [] : [transformed];
  });
}
