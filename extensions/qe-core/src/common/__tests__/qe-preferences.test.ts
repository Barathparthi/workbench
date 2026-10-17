import { describe, expect, it } from 'vitest';

import { qeCorePreferenceSchema, qeDesktopPreferenceSchema, QeRunnerFrameworks } from '../qe-preferences';

describe('qe.* preference schemas', () => {
  it('contributes the shared settings with typed defaults', () => {
    expect(Object.keys(qeCorePreferenceSchema.properties).sort()).toEqual([
      'qe.remote.defaultShell',
      'qe.runner.framework',
      'qe.runner.junitGlob',
    ]);
    for (const property of Object.values(qeCorePreferenceSchema.properties)) {
      expect(typeof property.default).toBe(property.type);
      expect(property.description).toBeTruthy();
    }
  });

  it('defaults the runner framework to a value of its own enum', () => {
    const framework = qeCorePreferenceSchema.properties['qe.runner.framework'];
    expect(framework?.enum).toEqual([...QeRunnerFrameworks]);
    expect(QeRunnerFrameworks).toContain(framework?.default);
  });

  it('keeps telemetry out of the shared schema (desktop only, off by default)', () => {
    expect(qeCorePreferenceSchema.properties).not.toHaveProperty('qe.telemetry.enabled');
    expect(qeDesktopPreferenceSchema.properties['qe.telemetry.enabled']).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('uses only the qe.* namespace', () => {
    const keys = [
      ...Object.keys(qeCorePreferenceSchema.properties),
      ...Object.keys(qeDesktopPreferenceSchema.properties),
    ];
    expect(keys.every((key) => key.startsWith('qe.'))).toBe(true);
  });
});
