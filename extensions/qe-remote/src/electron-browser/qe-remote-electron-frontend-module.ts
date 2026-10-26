import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { QeCommands } from '@qe/theia-qe-core/lib/browser/qe-commands';

/**
 * Desktop: the renderer runs from `file://`, so it must not talk to the broker itself — remote connections relay
 * through the Electron backend with the user's desktop sign-in (ADR-006, risk R17). That arrives in Phase 10; until
 * then the command explains it instead of trying an origin the broker (correctly) refuses.
 */
@injectable()
export class QeRemoteDesktopContribution implements CommandContribution {
  @inject(MessageService) protected readonly messages!: MessageService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(QeCommands.CONNECT_TARGET, {
      execute: () => this.messages.info('Remote systems in the desktop app arrive with desktop sign-in.'),
    });
  }
}

export default new ContainerModule((bind) => {
  bind(QeRemoteDesktopContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(QeRemoteDesktopContribution);
});
