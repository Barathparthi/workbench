import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import type { CommandRegistry } from '@theia/core/lib/common/command';
import { inject, injectable } from '@theia/core/shared/inversify';
import { QeCommands } from '@qe/theia-qe-core/lib/browser/qe-commands';

import { QeTestRuns } from './qe-test-runs';
import { QeTestWidget } from './qe-test-widget';

/** Opens the QE Tests view ("QE: Show Tests"); Theia's own toggle stays as "Toggle QE Tests". */
export const SHOW_QE_TESTS = { id: 'qe.runner.show', category: QeCommands.CATEGORY, label: 'Show Tests' };

/**
 * The QE Tests view, "QE: Show Tests", and "QE: Run Tests" (qe.runner.run, also on the welcome page): it opens the
 * view and runs every test of the project folder.
 */
@injectable()
export class QeRunnerContribution extends AbstractViewContribution<QeTestWidget> {
  @inject(QeTestRuns) protected readonly runs!: QeTestRuns;

  constructor() {
    super({
      widgetId: QeTestWidget.ID,
      widgetName: QeTestWidget.LABEL,
      defaultWidgetOptions: { area: 'left', rank: 600 },
      toggleCommandId: 'qe.runner.toggleView',
    });
  }

  override registerCommands(registry: CommandRegistry): void {
    super.registerCommands(registry);
    registry.registerCommand(SHOW_QE_TESTS, {
      execute: () => this.openView({ activate: true, reveal: true }),
    });
    registry.registerCommand(QeCommands.RUN_TESTS, {
      execute: async () => {
        await this.openView({ activate: true, reveal: true });
        await this.runs.run({ kind: 'all' });
      },
    });
  }
}
