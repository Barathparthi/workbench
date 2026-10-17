import { CommandContribution } from '@theia/core/lib/common';
import { ContainerModule } from '@theia/core/shared/inversify';
import { FileServiceContribution } from '@theia/filesystem/lib/browser/file-service';

import { QeRemoteBContribution, QeRemoteBFileSystemContribution } from './qe-remote-b-contribution';

export default new ContainerModule((bind) => {
  bind(QeRemoteBContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(QeRemoteBContribution);
  bind(QeRemoteBFileSystemContribution).toSelf().inSingletonScope();
  bind(FileServiceContribution).toService(QeRemoteBFileSystemContribution);
});
