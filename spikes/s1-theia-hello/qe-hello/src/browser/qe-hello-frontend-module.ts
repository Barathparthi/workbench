import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { ContainerModule } from '@theia/core/shared/inversify';
import { QeHelloCommandContribution, QeHelloMenuContribution } from './qe-hello-contribution';

export default new ContainerModule((bind) => {
  bind(CommandContribution).to(QeHelloCommandContribution);
  bind(MenuContribution).to(QeHelloMenuContribution);
});
