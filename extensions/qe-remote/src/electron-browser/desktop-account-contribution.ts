import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types';
import { CommandRegistry, type Command, type CommandContribution } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { inject, injectable } from '@theia/core/shared/inversify';

import { DesktopAccountService, type DesktopAccountStatus } from '../common/desktop-account-protocol';

export const QE_DESKTOP_SIGN_IN: Command = {
  id: 'qe.desktop.signIn',
  category: 'QE',
  label: 'Sign In to QE Workspace',
};
export const QE_DESKTOP_SIGN_OUT: Command = {
  id: 'qe.desktop.signOut',
  category: 'QE',
  label: 'Sign Out of QE Workspace',
};
export const QE_DESKTOP_ACCOUNT_STATUS_ID = 'qe-desktop-account';

/** What the status bar shows for a state; `undefined` hides it (no control plane configured). */
export function accountStatusEntry(
  status: DesktopAccountStatus | 'signing-in',
): { text: string; tooltip: string; command: string } | undefined {
  if (status === 'signing-in') {
    return {
      text: '$(sync~spin) Signing in…',
      tooltip: 'Finish signing in in your browser.',
      command: QE_DESKTOP_SIGN_IN.id,
    };
  }
  switch (status.state) {
    case 'not-configured':
      return undefined;
    case 'signed-out':
      return {
        text: '$(account) Sign in',
        tooltip: 'Sign in to QE Workspace to use your organisation’s systems.',
        command: QE_DESKTOP_SIGN_IN.id,
      };
    case 'signed-in':
      return {
        text: `$(account) ${status.username}`,
        tooltip:
          `Signed in to QE Workspace as ${status.displayName}` +
          (status.remembered ? '.' : ' until you close the app (this system has no secure storage).') +
          ' Click to sign out.',
        command: QE_DESKTOP_SIGN_OUT.id,
      };
  }
}

/**
 * The desktop app's sign-in to its control plane (PHASE_10 §10.4): commands and a status bar entry. Everything that
 * matters happens in the Electron backend — this page only asks for a status and never sees a token.
 */
@injectable()
export class DesktopAccountContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(DesktopAccountService) protected readonly account!: DesktopAccountService;
  @inject(StatusBar) protected readonly statusBar!: StatusBar;
  @inject(MessageService) protected readonly messages!: MessageService;

  onStart(): void {
    void this.account.status().then(
      (status) => this.show(status),
      () => this.show({ state: 'signed-out' }),
    );
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(QE_DESKTOP_SIGN_IN, { execute: () => this.signIn() });
    registry.registerCommand(QE_DESKTOP_SIGN_OUT, { execute: () => this.signOut() });
  }

  protected async signIn(): Promise<void> {
    await this.show('signing-in');
    try {
      const status = await this.account.signIn();
      await this.show(status);
      if (status.state === 'signed-in') {
        void this.messages.info(
          `Signed in to QE Workspace as ${status.displayName}.` +
            (status.remembered
              ? ''
              : ' This system has no secure storage: you will sign in again next time.'),
        );
      }
    } catch (error) {
      await this.show(await this.account.status().catch(() => ({ state: 'signed-out' }) as const));
      const message = error instanceof Error ? error.message : '';
      // The backend's messages are written for the user; a cancelled sign-in needs no message.
      if (!message.includes('cancelled')) {
        void this.messages.error(message.length > 0 ? message : 'The sign-in did not complete.');
      }
    }
  }

  protected async signOut(): Promise<void> {
    await this.account.signOut();
    await this.show({ state: 'signed-out' });
    void this.messages.info('Signed out of QE Workspace.');
  }

  protected async show(status: DesktopAccountStatus | 'signing-in'): Promise<void> {
    const entry = accountStatusEntry(status);
    if (entry === undefined) {
      await this.statusBar.removeElement(QE_DESKTOP_ACCOUNT_STATUS_ID);
      return;
    }
    await this.statusBar.setElement(QE_DESKTOP_ACCOUNT_STATUS_ID, {
      ...entry,
      alignment: StatusBarAlignment.RIGHT,
      priority: 100,
    });
  }
}
