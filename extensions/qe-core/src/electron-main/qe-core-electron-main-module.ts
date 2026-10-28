import { join } from 'node:path';

import { app } from '@theia/core/electron-shared/electron';
import { ContainerModule } from '@theia/core/shared/inversify';

/**
 * The installed desktop app (PHASE_10 §10.7): the built-in VS Code plugins ship next to it as extra resources
 * (apps/ide-electron/electron-builder.yml), where Theia does not look by itself. Set before the backend is forked, so
 * the backend inherits it; an explicit THEIA_DEFAULT_PLUGINS still wins.
 */
export default new ContainerModule(() => {
  if (app.isPackaged && process.env['THEIA_DEFAULT_PLUGINS'] === undefined) {
    process.env['THEIA_DEFAULT_PLUGINS'] = `local-dir:${join(process.resourcesPath, 'plugins')}`;
  }
});
