import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types';
import { ILogger } from '@theia/core/lib/common/logger';
import { Container } from '@theia/core/shared/inversify';
import { describe, expect, it, vi } from 'vitest';

import { featuresFor, QeEnvironmentService, type QeEnvironment } from '../../common/qe-environment';
import { QE_MODE_STATUS_ID } from '../qe-mode-status';
import { QeStatusBarContribution } from '../qe-status-bar';

function setUp(getEnvironment: () => Promise<QeEnvironment>) {
  const setElement = vi.fn(() => Promise.resolve());
  const error = vi.fn(() => Promise.resolve());
  const container = new Container();
  container.bind(StatusBar).toConstantValue({ setElement });
  container.bind(QeEnvironmentService).toConstantValue({ getEnvironment });
  container.bind(ILogger).toConstantValue({ error });
  container.bind(QeStatusBarContribution).toSelf();
  return { contribution: container.get(QeStatusBarContribution), setElement, error };
}

describe('QeStatusBarContribution', () => {
  it('does not block startup on the RPC call and then shows the mode', async () => {
    let resolve: (env: QeEnvironment) => void = () => undefined;
    const pending = new Promise<QeEnvironment>((r) => (resolve = r));
    const { contribution, setElement } = setUp(() => pending);

    contribution.onStart();
    expect(setElement).not.toHaveBeenCalled();

    resolve({ mode: 'desktop', features: featuresFor('desktop', undefined) });
    await vi.waitFor(() => {
      expect(setElement).toHaveBeenCalledWith(
        QE_MODE_STATUS_ID,
        expect.objectContaining({ text: '$(device-desktop) QE Desktop', alignment: StatusBarAlignment.LEFT }),
      );
    });
  });

  it('logs and shows a warning when the environment cannot be read', async () => {
    const { contribution, setElement, error } = setUp(() => Promise.reject(new Error('backend gone')));
    contribution.onStart();
    await vi.waitFor(() => {
      expect(setElement).toHaveBeenCalledWith(
        QE_MODE_STATUS_ID,
        expect.objectContaining({ text: '$(warning) QE' }),
      );
    });
    expect(error).toHaveBeenCalledWith('QE environment unavailable', expect.any(Error));
  });
});
