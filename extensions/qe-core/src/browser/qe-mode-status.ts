import type { QeEnvironment } from '../common/qe-environment';

export const QE_MODE_STATUS_ID = 'qe-mode';

const LABELS: Readonly<Record<QeEnvironment['mode'], { icon: string; label: string }>> = {
  hosted: { icon: 'cloud', label: 'Hosted' },
  'local-web': { icon: 'home', label: 'Local' },
  desktop: { icon: 'device-desktop', label: 'Desktop' },
};

/** Status bar text and tooltip for the IDE's mode (codicon syntax `$(name)`). */
export function modeStatus(environment: QeEnvironment | undefined): { text: string; tooltip: string } {
  if (environment === undefined) {
    return { text: '$(warning) QE', tooltip: 'QE Workspace: environment unavailable' };
  }
  const { icon, label } = LABELS[environment.mode];
  const connected =
    environment.controlPlaneUrl === undefined
      ? 'not connected to a control plane'
      : `control plane ${environment.controlPlaneUrl}`;
  return {
    text: `$(${icon}) QE ${label}`,
    tooltip: `QE Workspace — ${label.toLowerCase()} mode, ${connected}`,
  };
}
