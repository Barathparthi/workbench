import { join } from 'node:path';

import { app, safeStorage, shell } from '@theia/core/electron-shared/electron';
import { ElectronMainApplication } from '@theia/core/lib/electron-main/electron-main-application';
import { ContainerModule, injectable } from '@theia/core/shared/inversify';

import { DESKTOP_HOST_ENV, type DesktopHostAddress } from '../common/desktop-host-protocol';
import { secretFileStore, startDesktopHost, type DesktopHost, type StringCipher } from './desktop-host';

/**
 * `safeStorage` (Keychain, DPAPI, libsecret/kwallet). On Linux without a keyring Electron falls back to `basic_text`,
 * a fixed key — plain text in effect — which counts as unavailable. Only valid once the app is ready.
 */
async function safeStorageCipher(): Promise<StringCipher> {
  await app.whenReady();
  const available =
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  return {
    available,
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  };
}

/**
 * Starts the desktop host channel (desktop-host-protocol.ts) just before Theia forks the backend, and hands the
 * backend — and only the backend — its address and token.
 */
@injectable()
export class QeElectronMainApplication extends ElectronMainApplication {
  protected desktopHost: Promise<DesktopHost> | undefined;

  // The return type is inferred: naming ForkOptions would import node:child_process here.
  protected override async getForkOptions() {
    const options = await super.getForkOptions();
    this.desktopHost ??= startDesktopHost({
      secrets: secretFileStore(join(app.getPath('userData'), 'qe-secrets'), safeStorageCipher),
      openExternal: (url) => shell.openExternal(url),
    }).then((host) => {
      app.once('will-quit', () => {
        void host.close();
      });
      return host;
    });
    const host = await this.desktopHost;
    const address: DesktopHostAddress = { address: host.address, token: host.token };
    return { ...options, env: { ...options.env, [DESKTOP_HOST_ENV]: JSON.stringify(address) } };
  }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bind(QeElectronMainApplication).toSelf().inSingletonScope();
  rebind(ElectronMainApplication).toService(QeElectronMainApplication);
});
