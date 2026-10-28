import { ContainerModule } from '@theia/core/shared/inversify';

import { bindQeRemoteFrontend } from '../browser/qe-remote-frontend-module';

/**
 * Desktop: the same remote features as the browser app. The renderer runs from `file://`, so it never talks to the
 * hosted broker itself (risk R17): personal targets go through the embedded broker in the Electron backend; managed
 * targets arrive with desktop sign-in and a backend relay (Phase 10.4).
 */
export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bindQeRemoteFrontend(bind, rebind);
});
