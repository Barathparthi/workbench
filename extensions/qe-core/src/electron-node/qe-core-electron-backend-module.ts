import { ContainerModule } from '@theia/core/shared/inversify';

import { bindQeCoreBackend } from '../node/qe-core-backend-module';
import { parseQeEnvironment } from '../node/qe-environment-config';

// Theia loads this instead of the browser backend module in the Electron app: always desktop mode.
export default new ContainerModule((bind) => {
  bindQeCoreBackend(bind, parseQeEnvironment(process.env, 'electron'));
});
