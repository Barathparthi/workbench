import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';
import { ContainerModule } from '@theia/core/shared/inversify';

import { qeDesktopPreferenceSchema } from '../common/qe-preferences';
import { bindQeCoreFrontend } from '../browser/qe-core-frontend-module';

// Theia loads this instead of the browser frontend module in the Electron app.
export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bindQeCoreFrontend(bind, rebind);
  bind(PreferenceContribution).toConstantValue({ schema: qeDesktopPreferenceSchema });
});
