import { LabelProviderContribution } from '@theia/core/lib/browser/label-provider';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule, type interfaces } from '@theia/core/shared/inversify';
import { FileServiceContribution } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';

import { EMBEDDED_BROKER_PATH, type EmbeddedBrokerService } from '../common/embedded-broker-protocol';
import { QeRemoteContribution } from './qe-remote-contribution';
import {
  EmbeddedBrokerConnector,
  QeRemoteServices,
  QeSshFileSystemContribution,
  QeSshLabelProviderContribution,
  RemoteTargetNames,
} from './qe-remote-files';
import { QeWorkspaceService } from './qe-workspace-service';

/** The remote features, the same in the browser and the desktop app (09_LOCAL_AND_WEB_PARITY §3.1). */
export function bindQeRemoteFrontend(bind: interfaces.Bind, rebind: interfaces.Rebind): void {
  bind(EmbeddedBrokerConnector).toDynamicValue(
    (ctx): EmbeddedBrokerConnector =>
      (client) =>
        ServiceConnectionProvider.createProxy<EmbeddedBrokerService>(
          ctx.container,
          EMBEDDED_BROKER_PATH,
          client,
        ),
  );
  bind(QeRemoteServices).toSelf().inSingletonScope();
  bind(RemoteTargetNames).toSelf().inSingletonScope();
  bind(QeRemoteContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(QeRemoteContribution);
  // Remote files (Phase 09): the provider is registered by a contribution with no FileService-dependent injections.
  bind(QeSshFileSystemContribution).toSelf().inSingletonScope();
  bind(FileServiceContribution).toService(QeSshFileSystemContribution);
  bind(QeSshLabelProviderContribution).toSelf().inSingletonScope();
  bind(LabelProviderContribution).toService(QeSshLabelProviderContribution);
  // Remote folders are real workspace roots: keep their qe-ssh:// URIs intact in the workspace file.
  rebind(WorkspaceService).to(QeWorkspaceService).inSingletonScope();
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bindQeRemoteFrontend(bind, rebind);
});
