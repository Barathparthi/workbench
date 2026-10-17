import { describe, expect, it } from 'vitest';

import { featuresFor, type QeMode } from '../../common/qe-environment';
import { modeStatus } from '../qe-mode-status';

const env = (mode: QeMode, controlPlaneUrl?: string) => ({
  mode,
  ...(controlPlaneUrl !== undefined && { controlPlaneUrl }),
  features: featuresFor(mode, controlPlaneUrl),
});

describe('modeStatus', () => {
  it.each([
    ['hosted', '$(cloud) QE Hosted'],
    ['local-web', '$(home) QE Local'],
    ['desktop', '$(device-desktop) QE Desktop'],
  ] as const)('labels %s mode', (mode, text) => {
    expect(modeStatus(env(mode)).text).toBe(text);
  });

  it('names the control plane when connected', () => {
    expect(modeStatus(env('hosted', 'https://qe.example.corp/')).tooltip).toBe(
      'QE Workspace — hosted mode, control plane https://qe.example.corp/',
    );
    expect(modeStatus(env('desktop')).tooltip).toBe(
      'QE Workspace — desktop mode, not connected to a control plane',
    );
  });

  it('shows a warning when the environment could not be read', () => {
    expect(modeStatus(undefined)).toEqual({
      text: '$(warning) QE',
      tooltip: 'QE Workspace: environment unavailable',
    });
  });
});
