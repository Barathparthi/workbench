import { CommandRegistry, type CommandContribution, MessageService } from '@theia/core/lib/common';
import type { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { Container } from '@theia/core/shared/inversify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QeCommandContribution, QeCommands } from '../qe-commands';

describe('QeCommandContribution', () => {
  let registry: CommandRegistry;
  let info: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    info = vi.fn(() => Promise.resolve(undefined));
    const container = new Container();
    container.bind(MessageService).toConstantValue({ info } as unknown as MessageService);
    container.bind(QeCommandContribution).toSelf().inSingletonScope();
    const noContributions: ContributionProvider<CommandContribution> = { getContributions: () => [] };
    registry = new CommandRegistry(noContributions);
    container.get(QeCommandContribution).registerCommands(registry);
  });

  it('registers the four QE commands in the QE category', () => {
    for (const command of [
      QeCommands.ABOUT,
      QeCommands.OPEN_WORKSPACE,
      QeCommands.CONNECT_TARGET,
      QeCommands.RUN_TESTS,
    ]) {
      expect(registry.getCommand(command.id)).toMatchObject({ category: 'QE', label: command.label });
    }
    expect(registry.getCommand(QeCommands.ABOUT.id)?.label).toBe('About QE Workspace');
  });

  it('implements About', async () => {
    await registry.executeCommand(QeCommands.ABOUT.id);
    expect(info).toHaveBeenCalledWith('QE Workspace');
  });

  it.each([QeCommands.OPEN_WORKSPACE, QeCommands.CONNECT_TARGET, QeCommands.RUN_TESTS])(
    'keeps $id as a placeholder that only reports it is not available yet',
    async (command) => {
      await registry.executeCommand(command.id);
      expect(info).toHaveBeenCalledExactlyOnceWith(`${command.label ?? ''} is available in a later phase.`);
    },
  );

  it('registers nothing outside the QE namespace', () => {
    expect(registry.commandIds.filter((id) => !id.startsWith('qe.'))).toEqual([]);
  });
});
