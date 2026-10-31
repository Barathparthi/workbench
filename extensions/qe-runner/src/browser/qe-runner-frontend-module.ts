import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { ContainerModule } from '@theia/core/shared/inversify';

import { QeRunnerContribution } from './qe-runner-contribution';
import { QeTestRuns } from './qe-test-runs';
import { QeTestWidget } from './qe-test-widget';

/** The QE Tests panel, the same in the browser and the desktop app (09_LOCAL_AND_WEB_PARITY §3.1). */
export default new ContainerModule((bind) => {
  bind(QeTestRuns).toSelf().inSingletonScope();
  bind(QeTestWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: QeTestWidget.ID,
      createWidget: () => ctx.container.get(QeTestWidget),
    }))
    .inSingletonScope();
  bindViewContribution(bind, QeRunnerContribution);
  bind(FrontendApplicationContribution).toService(QeRunnerContribution);
});
