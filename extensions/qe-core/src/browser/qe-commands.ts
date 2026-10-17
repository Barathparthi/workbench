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
  RUN_TESTS: qeCommand('qe.runner.run', 'Run Tests'),
  ABOUT: qeCommand('qe.about', 'About QE Workspace'),
} as const;

/** Commands implemented by later phases (workspaces: 05, remote: 08, runner: 11). */
const PLACEHOLDERS: readonly Command[] = [
  QeCommands.OPEN_WORKSPACE,
  QeCommands.CONNECT_TARGET,
  QeCommands.RUN_TESTS,
];

@injectable()
export class QeCommandContribution implements CommandContribution {
  @inject(MessageService) protected readonly messages!: MessageService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(QeCommands.ABOUT, { execute: () => this.messages.info('QE Workspace') });
    for (const command of PLACEHOLDERS) {
      registry.registerCommand(command, {
        execute: () => this.messages.info(`${command.label ?? command.id} is available in a later phase.`),
      });
    }
  }
}
