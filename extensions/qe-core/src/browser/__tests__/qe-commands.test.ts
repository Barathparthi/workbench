import { CommandRegistry, type CommandContribution, MessageService } from '@theia/core/lib/common';
import type { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { Container } from '@theia/core/shared/inversify';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { QeCommandContribution, QeCommands, THEIA_ABOUT_COMMAND_ID } from '../qe-commands';

describe('QeCommandContribution', () => {
  let registry: CommandRegistry;
  let info: ReturnType<typeof vi.fn>;
  let openAbout: Mock<() => Promise<undefined>>;

  beforeEach(() => {
    info = vi.fn(() => Promise.resolve(undefined));
    const container = new Container();
    openAbout = vi.fn(() => Promise.resolve(undefined));
    container.bind(MessageService).toConstantValue({ info } as unknown as MessageService);
    container.bind(QeCommandContribution).toSelf().inSingletonScope();
    const noContributions: ContributionProvider<CommandContribution> = { getContributions: () => [] };
    registry = new CommandRegistry(noContributions);
    // Stands in for Theia's core About command, which opens the About dialog.
    registry.registerCommand({ id: THEIA_ABOUT_COMMAND_ID }, { execute: openAbout });
    container.get(QeCommandContribution).registerCommands(registry);
  });

  it('registers its QE commands in the QE category', () => {
    for (const command of [QeCommands.ABOUT, QeCommands.OPEN_WORKSPACE]) {
      expect(registry.getCommand(command.id)).toMatchObject({ category: 'QE', label: command.label });
    }
    expect(registry.getCommand(QeCommands.ABOUT.id)?.label).toBe('About QE Workspace');
  });

  it('leaves Run Tests to the qe-runner extension (defined here, implemented there)', () => {
    expect(QeCommands.RUN_TESTS).toMatchObject({ id: 'qe.runner.run', label: 'Run Tests' });
    expect(registry.getCommand(QeCommands.RUN_TESTS.id)).toBeUndefined();
  });

  it('leaves Connect to the qe-remote extension (defined here, implemented there)', () => {
    expect(QeCommands.CONNECT_TARGET).toMatchObject({
      id: 'qe.remote.connect',
      label: 'Connect to Remote System…',
    });
    expect(registry.getCommand(QeCommands.CONNECT_TARGET.id)).toBeUndefined();
  });

  it('implements About by opening the (QE-branded) About dialog', async () => {
    await registry.executeCommand(QeCommands.ABOUT.id);
    expect(openAbout).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
  });

  it.each([QeCommands.OPEN_WORKSPACE])(
    'keeps $id as a placeholder that only reports it is not available yet',
    async (command) => {
      await registry.executeCommand(command.id);
      expect(info).toHaveBeenCalledExactlyOnceWith(`${command.label ?? ''} is available in a later phase.`);
    },
  );

  it('registers nothing outside the QE namespace', () => {
    expect(
      registry.commandIds.filter((id) => !id.startsWith('qe.') && id !== THEIA_ABOUT_COMMAND_ID),
    ).toEqual([]);
  });
});
