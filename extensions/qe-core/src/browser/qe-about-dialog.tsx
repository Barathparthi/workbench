import { AboutDialog } from '@theia/core/lib/browser/about-dialog';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';

import { QeEnvironmentService, type QeEnvironment } from '../common/qe-environment';
import { modeStatus } from './qe-mode-status';

/** Theia's About dialog, led by the product name and the IDE's mode. */
@injectable()
export class QeAboutDialog extends AboutDialog {
  @inject(QeEnvironmentService) protected readonly environmentService!: QeEnvironmentService;
  protected environment: QeEnvironment | undefined;

  protected override async doInit(): Promise<void> {
    this.environment = await this.environmentService.getEnvironment().catch(() => undefined);
    await super.doInit();
  }

  protected override renderHeader(): React.ReactNode {
    return (
      <>
        <h2 className="qe-about-product">QE Workspace</h2>
        <p className="qe-about-mode">{modeStatus(this.environment).tooltip}</p>
        <p>Built on Eclipse Theia.</p>
        {super.renderHeader()}
      </>
    );
  }
}
