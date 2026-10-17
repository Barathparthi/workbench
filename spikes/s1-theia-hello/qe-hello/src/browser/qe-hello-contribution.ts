import { injectable, inject } from '@theia/core/shared/inversify';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
} from '@theia/core/lib/common';
import { CommonMenus } from '@theia/core/lib/browser';
import { environment } from '@theia/core/shared/@theia/application-package/lib/environment';

export const QeHelloCommand: Command = {
  id: 'qe.hello',
  label: 'QE: Say Hello',
};

@injectable()
export class QeHelloCommandContribution implements CommandContribution {
  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(QeHelloCommand, {
      execute: () => {
        const target = environment.electron.is() ? 'electron' : 'browser';
        return this.messageService.info(`Hello from QE Workspace (${target})`);
      },
    });
  }
}

@injectable()
export class QeHelloMenuContribution implements MenuContribution {
  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CommonMenus.HELP, {
      commandId: QeHelloCommand.id,
      label: QeHelloCommand.label,
    });
  }
}
