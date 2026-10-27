import { LabelProviderContribution } from '@theia/core/lib/browser/label-provider';
import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';
import { FileServiceContribution } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';

import { QeRemoteContribution } from './qe-remote-contribution';
import {
  QeRemoteServices,
  QeSshFileSystemContribution,
  QeSshLabelProviderContribution,
  RemoteTargetNames,
} from './qe-remote-files';
import { QeWorkspaceService } from './qe-workspace-service';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bind(QeRemoteServices).toSelf().inSingletonScope();
  bind(RemoteTargetNames).toSelf().inSingletonScope();
  bind(QeRemoteContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(QeRemoteContribution);
  // Remote files (Phase 09): the provider is registered by a contribution with no FileService-dependent injections.
  bind(QeSshFileSystemContribution).toSelf().inSingletonScope();
  bind(FileServiceContribution).toService(QeSshFileSystemContribution);
  bind(QeSshLabelProviderContribution).toSelf().inSingletonScope();
  bind(LabelProviderContribution).toService(QeSshLabelProviderContribution);
  // Remote folders are real workspace roots: keep their qe-ssh:// URIs intact in the workspace file.
  rebind(WorkspaceService).to(QeWorkspaceService).inSingletonScope();
});
