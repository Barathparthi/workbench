import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable } from '@theia/core/shared/inversify';

import { QeEnvironmentService, type QeEnvironment } from '../common/qe-environment';
import { modeStatus, QE_MODE_STATUS_ID } from './qe-mode-status';

/** Shows the IDE's mode (hosted / local / desktop) at the left of the status bar. */
@injectable()
export class QeStatusBarContribution implements FrontendApplicationContribution {
  @inject(StatusBar) protected readonly statusBar!: StatusBar;
  @inject(QeEnvironmentService) protected readonly environmentService!: QeEnvironmentService;
  @inject(ILogger) protected readonly logger!: ILogger;

  // Theia awaits each onStart before showing the shell, so the RPC round trip must not block startup.
  onStart(): void {
    void this.showMode();
  }

  protected async showMode(): Promise<void> {
    let environment: QeEnvironment | undefined;
    try {
      environment = await this.environmentService.getEnvironment();
    } catch (error) {
      await this.logger.error('QE environment unavailable', error);
    }
    await this.statusBar.setElement(QE_MODE_STATUS_ID, {
      ...modeStatus(environment),
      alignment: StatusBarAlignment.LEFT,
      priority: 100,
    });
  }
}
