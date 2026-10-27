import { LabelProviderContribution } from '@theia/core/lib/browser/label-provider';
import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';
import { FileServiceContribution } from '@theia/filesystem/lib/browser/file-service';

import { QeRemoteContribution } from './qe-remote-contribution';
import {
  QeRemoteServices,
  QeSshFileSystemContribution,
  QeSshLabelProviderContribution,
  RemoteTargetNames,
} from './qe-remote-files';

export default new ContainerModule((bind) => {
  bind(QeRemoteServices).toSelf().inSingletonScope();
  bind(RemoteTargetNames).toSelf().inSingletonScope();
  bind(QeRemoteContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(QeRemoteContribution);
  // Remote files (Phase 09): the provider is registered by a contribution with no FileService-dependent injections.
  bind(QeSshFileSystemContribution).toSelf().inSingletonScope();
  bind(FileServiceContribution).toService(QeSshFileSystemContribution);
  bind(QeSshLabelProviderContribution).toSelf().inSingletonScope();
  bind(LabelProviderContribution).toService(QeSshLabelProviderContribution);
});
