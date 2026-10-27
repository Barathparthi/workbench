import { injectable } from '@theia/core/shared/inversify';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import { WorkspaceData, WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import * as jsoncparser from 'jsonc-parser';

import { mapFolders } from '../common/workspace-folders';

/**
 * Theia's workspace service, but `qe-ssh://` roots survive the workspace file (see `mapFolders`): "Open Remote
 * Folder" adds the remote folder as a real workspace root, so the Explorer's own commands (new file, rename,
 * delete, …) work on it. Local roots are written and read exactly as Theia does.
 */
@injectable()
export class QeWorkspaceService extends WorkspaceService {
  protected override async writeWorkspaceFile(
    workspaceFile: FileStat | undefined,
    workspaceData: WorkspaceData,
  ): Promise<FileStat | undefined> {
    if (workspaceFile === undefined) return undefined;
    const folders = mapFolders(
      workspaceData.folders,
      (folder) =>
        WorkspaceData.transformToRelative({ ...workspaceData, folders: [folder] }, workspaceFile).folders[0],
    );
    await this.fileService.write(
      workspaceFile.resource,
      JSON.stringify({ ...workspaceData, folders }, undefined, 2),
    );
    return this.fileService.resolve(workspaceFile.resource);
  }

  protected override async getWorkspaceDataFromFile(): Promise<WorkspaceData | undefined> {
    const workspace = this._workspace;
    if (
      workspace === undefined ||
      !this.isWorkspaceFile(workspace) ||
      !(await this.fileService.exists(workspace.resource))
    ) {
      return super.getWorkspaceDataFromFile();
    }
    const stat = await this.fileService.read(workspace.resource);
    const data: unknown = jsoncparser.parse(jsoncparser.stripComments(stat.value));
    if (!WorkspaceData.is(data)) return super.getWorkspaceDataFromFile(); // Theia logs the problem
    const folders = mapFolders(
      data.folders,
      (folder) => WorkspaceData.transformToAbsolute({ ...data, folders: [folder] }, stat).folders[0],
    );
    return { ...data, folders };
  }
}
