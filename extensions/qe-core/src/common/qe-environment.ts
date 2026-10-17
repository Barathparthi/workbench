/**
 * Which kind of QE Workspace this IDE is (02_SOLUTION_ARCHITECTURE §2, 09_LOCAL_AND_WEB_PARITY §3.2).
 * The backend derives it once at startup; the frontend reads it over RPC and never from the URL.
 */
export const QeModes = ['hosted', 'local-web', 'desktop'] as const;
export type QeMode = (typeof QeModes)[number];

/** Capabilities the UI may offer in a mode. The backend enforces them too — hiding UI is never enough. */
export interface QeFeatures {
  /** Targets the user defines locally (~/.ssh/config), reached through the embedded broker. */
  readonly personalTargets: boolean;
  /** Registered targets reached through the hosted control plane and broker. */
  readonly managedTargets: boolean;
  /** Workspace picker and lifecycle UI (hosted workspaces only). */
  readonly workspacePicker: boolean;
}

export interface QeEnvironment {
  readonly mode: QeMode;
  /** Hosted, or local web / desktop connected to a control plane. */
  readonly controlPlaneUrl?: string;
  /** Hosted only: the workspace this runtime serves. */
  readonly workspaceId?: string;
  readonly features: QeFeatures;
}

export function featuresFor(mode: QeMode, controlPlaneUrl: string | undefined): QeFeatures {
  const connected = controlPlaneUrl !== undefined;
  switch (mode) {
    case 'hosted':
      return { personalTargets: false, managedTargets: true, workspacePicker: true };
    case 'local-web':
    case 'desktop':
      return { personalTargets: true, managedTargets: connected, workspacePicker: false };
  }
}

export const QE_ENVIRONMENT_SERVICE_PATH = '/services/qe-environment';

export const QeEnvironmentService = Symbol('QeEnvironmentService');
export interface QeEnvironmentService {
  getEnvironment(): Promise<QeEnvironment>;
}
