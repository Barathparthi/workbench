import { ContainerModule } from '@theia/core/shared/inversify';

import { bindQeCoreBackend, bindQeTerminalPolicy, environmentOrExit } from '../node/qe-core-backend-module';

// Theia loads this instead of the browser backend module in the Electron app: always desktop mode.
export default new ContainerModule((bind, _unbind, _isBound, _rebind, _unbindAsync, onActivation) => {
  const environment = environmentOrExit('electron');
  bindQeCoreBackend(bind, environment);
  bindQeTerminalPolicy(onActivation, environment);
});
