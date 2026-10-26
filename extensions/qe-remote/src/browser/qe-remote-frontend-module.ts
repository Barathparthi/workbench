import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';

import { QeRemoteContribution } from './qe-remote-contribution';

export default new ContainerModule((bind) => {
  bind(QeRemoteContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(QeRemoteContribution);
});
