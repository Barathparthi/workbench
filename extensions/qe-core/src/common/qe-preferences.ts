import type { PreferenceSchema } from '@theia/core/lib/common/preferences/preference-schema';

export const QE_DOCUMENTATION_URL_PREFERENCE = 'qe.help.documentationUrl';

export const QeRunnerFrameworks = ['auto', 'pytest', 'maven'] as const;
export type QeRunnerFramework = (typeof QeRunnerFrameworks)[number];

/** `qe.*` settings available in every mode. Consumers arrive with the features (Phases 08, 11). */
export const qeCorePreferenceSchema: PreferenceSchema = {
  properties: {
    'qe.remote.defaultShell': {
      type: 'string',
      default: '',
      description: 'Shell started for remote terminals. Empty: the target account’s login shell.',
    },
    'qe.runner.framework': {
      type: 'string',
      enum: [...QeRunnerFrameworks],
      default: 'auto',
      description: 'Test framework for "QE: Run Tests". "auto" detects pytest or Maven from the project.',
    },
    [QE_DOCUMENTATION_URL_PREFERENCE]: {
      type: 'string',
      // Until the organisation publishes user documentation (org decision D13).
      default: 'https://github.com/Barathparthi/workbench/blob/main/04_OPERATIONS/USER_GUIDE.md',
      description: 'Opened by "Documentation" on the welcome page. Must be an https URL.',
    },
    'qe.runner.junitGlob': {
      type: 'string',
      default: '{**/junit*.xml,**/TEST-*.xml}',
      description: 'Glob for the JUnit XML result files to parse after a test run.',
    },
  },
};

/** Desktop-only settings: contributed by the Electron frontend module, so they never appear elsewhere. */
export const qeDesktopPreferenceSchema: PreferenceSchema = {
  properties: {
    'qe.telemetry.enabled': {
      type: 'boolean',
      default: false,
      description: 'Send anonymous usage and error telemetry from the desktop app.',
    },
  },
};
