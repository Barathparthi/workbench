import { ContainerModule } from '@theia/core/shared/inversify';

import { bindQeCoreBackend, environmentOrExit } from '../node/qe-core-backend-module';

// Theia loads this instead of the browser backend module in the Electron app: always desktop mode.
export default new ContainerModule((bind) => {
  bindQeCoreBackend(bind, environmentOrExit('electron'));
});
