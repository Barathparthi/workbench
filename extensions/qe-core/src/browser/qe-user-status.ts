import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types';
import { CommandRegistry, type Command, type CommandContribution } from '@theia/core/lib/common/command';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable } from '@theia/core/shared/inversify';

import { QeEnvironmentService } from '../common/qe-environment';

export const QE_USER_STATUS_ID = 'qe-user';
export const QE_SIGN_OUT: Command = { id: 'qe.auth.signOut', category: 'QE', label: 'Sign Out' };

/** The part of `GET /api/v1/me` the status bar shows. */
export interface MeSummary {
  readonly username: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export function parseMe(body: unknown): MeSummary | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.username !== 'string' || typeof b.displayName !== 'string' || !Array.isArray(b.roles)) {
    return undefined;
  }
  return {
    username: b.username,
    displayName: b.displayName,
    roles: b.roles.filter((r) => typeof r === 'string'),
  };
}

export function userStatus(me: MeSummary): { text: string; tooltip: string } {
  return {
    text: `$(account) ${me.username}`,
    tooltip: `${me.displayName} — roles: ${me.roles.join(', ') || 'none'}. Click to sign out.`,
  };
}

/** Reads one cookie from `document.cookie`. */
export function cookieValue(cookies: string, name: string): string | undefined {
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Hosted mode only: shows the signed-in user (from the control plane on the IDE's own origin, reached through
 * the workspace router) and offers Sign Out. The control plane enforces everything; this is display only.
 */
@injectable()
export class QeUserStatusContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(StatusBar) protected readonly statusBar!: StatusBar;
  @inject(QeEnvironmentService) protected readonly environmentService!: QeEnvironmentService;
  @inject(ILogger) protected readonly logger!: ILogger;

  onStart(): void {
    void this.show();
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(QE_SIGN_OUT, { execute: () => this.signOut() });
  }

  protected async show(): Promise<void> {
    try {
      const environment = await this.environmentService.getEnvironment();
      if (environment.mode !== 'hosted') return;
      const res = await fetch('/api/v1/me', { credentials: 'include', signal: AbortSignal.timeout(10_000) });
      const me = res.ok ? parseMe(await res.json()) : undefined;
      if (me === undefined) return;
      await this.statusBar.setElement(QE_USER_STATUS_ID, {
        ...userStatus(me),
        alignment: StatusBarAlignment.RIGHT,
        priority: 100,
        command: QE_SIGN_OUT.id,
      });
    } catch (error) {
      await this.logger.warn('QE user status unavailable', error);
    }
  }

  protected async signOut(): Promise<void> {
    const csrf = cookieValue(document.cookie, 'qews_csrf');
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: csrf === undefined ? {} : { 'x-csrf-token': csrf },
      signal: AbortSignal.timeout(10_000),
    });
    window.location.assign('/');
  }
}
