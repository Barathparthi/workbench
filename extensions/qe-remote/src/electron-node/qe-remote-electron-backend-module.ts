import { ContainerModule } from '@theia/core/shared/inversify';

import { bindEmbeddedBroker } from '../node/qe-remote-backend-module';

// The desktop app's backend runs on the user's machine: personal targets are always available (ADR-008).
export default new ContainerModule((bind) => {
  bindEmbeddedBroker(bind);
});
