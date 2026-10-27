import {
  type Command,
  type CommandContribution,
  type CommandRegistry,
  MessageService,
} from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';

const CATEGORY = 'QE';
const qeCommand = (id: string, label: string): Command => ({ id, category: CATEGORY, label });

export const QeCommands = {
  CATEGORY,
  OPEN_WORKSPACE: qeCommand('qe.workspace.open', 'Open Workspace…'),
  CONNECT_TARGET: qeCommand('qe.remote.connect', 'Connect to Remote System…'),
  OPEN_REMOTE_FOLDER: qeCommand('qe.remote.openFolder', 'Open Remote Folder…'),
  RUN_TESTS: qeCommand('qe.runner.run', 'Run Tests'),
  ABOUT: qeCommand('qe.about', 'About QE Workspace'),
} as const;

/** Theia's own About command (CommonCommands.ABOUT_COMMAND); it opens the QE-branded About dialog. */
export const THEIA_ABOUT_COMMAND_ID = 'core.about';

/**
 * Commands implemented by later phases (workspace picker, runner: 11). CONNECT_TARGET (it appears in the welcome page)
 * and OPEN_REMOTE_FOLDER are defined here and implemented by the qe-remote extension (Phases 08–09).
 */
const PLACEHOLDERS: readonly Command[] = [QeCommands.OPEN_WORKSPACE, QeCommands.RUN_TESTS];

@injectable()
export class QeCommandContribution implements CommandContribution {
  @inject(MessageService) protected readonly messages!: MessageService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(QeCommands.ABOUT, {
      execute: () => registry.executeCommand(THEIA_ABOUT_COMMAND_ID),
    });
    for (const command of PLACEHOLDERS) {
      registry.registerCommand(command, {
        execute: () => this.messages.info(`${command.label ?? command.id} is available in a later phase.`),
      });
    }
  }
}
