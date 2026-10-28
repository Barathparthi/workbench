import { describe, expect, it, vi } from 'vitest';

import { withManagedSettings } from '../qe-core-backend-module';
import {
  MANAGED_SETTINGS_FILES,
  MANAGED_SETTINGS_REGISTRY_KEY,
  parseRegistryOutput,
  readManagedSettings,
  type ManagedSettingsSource,
} from '../qe-managed-settings';
import { queryRegistry } from '../qe-managed-settings-registry';

/** `reg query HKLM\Software\Policies\QEWorkspace /reg:64` as Windows prints it. */
const REG_OUTPUT = [
  '',
  'HKEY_LOCAL_MACHINE\\Software\\Policies\\QEWorkspace',
  '    ControlPlaneUrl    REG_SZ    https://qe.corp.example',
  '    DeniedCidrs    REG_MULTI_SZ    10.0.0.0/8\\0192.168.0.0/16\\0fd00::/8',
  '    TrustOnFirstUse    REG_DWORD    0x0',
  '    Telemetry    REG_DWORD    0x1',
  '',
].join('\r\n');

const source = (over: Partial<ManagedSettingsSource>): ManagedSettingsSource => ({
  platform: 'linux',
  readFile: () => undefined,
  queryRegistry: () => undefined,
  ...over,
});
const linuxFile = (text: string) =>
  source({ readFile: (path) => (path === MANAGED_SETTINGS_FILES.linux ? text : undefined) });

describe('managed settings (ADR-013)', () => {
  it('reads the Windows policy key: text, switches and lists', () => {
    const query = vi.fn(() => REG_OUTPUT);
    expect(readManagedSettings(source({ platform: 'win32', queryRegistry: query }))).toEqual({
      origin: MANAGED_SETTINGS_REGISTRY_KEY,
      settings: {
        controlPlaneUrl: 'https://qe.corp.example',
        deniedCidrs: ['10.0.0.0/8', '192.168.0.0/16', 'fd00::/8'],
        trustOnFirstUse: false,
        telemetry: true,
      },
    });
    expect(query).toHaveBeenCalledWith('HKLM\\Software\\Policies\\QEWorkspace');
  });

  it('accepts a comma-separated deny list as plain text too', () => {
    expect(parseRegistryOutput('    DeniedCidrs    REG_SZ    10.0.0.0/8, 172.16.0.0/12')).toEqual({
      deniedCidrs: ['10.0.0.0/8', '172.16.0.0/12'],
    });
  });

  it('reads the policy file on Linux and macOS', () => {
    const json = JSON.stringify({ deniedCidrs: ['10.20.0.0/16'], trustOnFirstUse: false });
    expect(readManagedSettings(linuxFile(json))).toEqual({
      origin: '/etc/qe-workspace/policy.json',
      settings: { deniedCidrs: ['10.20.0.0/16'], trustOnFirstUse: false },
    });
    const mac = source({
      platform: 'darwin',
      readFile: (path) =>
        path === '/Library/Application Support/QEWorkspace/policy.json' ? '{}' : undefined,
    });
    expect(readManagedSettings(mac).origin).toBe('/Library/Application Support/QEWorkspace/policy.json');
  });

  it('means no settings when the machine has none', () => {
    expect(readManagedSettings(source({}))).toEqual({ settings: {} });
    expect(readManagedSettings(source({ platform: 'win32' }))).toEqual({ settings: {} });
  });

  it.each([
    ['not JSON', '{ deniedCidrs: [', 'not valid JSON'],
    [
      'an unknown setting (a typo must not drop a policy)',
      '{"deniedCidr": ["10.0.0.0/8"]}',
      'unknown deniedCidr',
    ],
    ['a deny list entry that is no CIDR', '{"deniedCidrs": ["10.0.0.0"]}', 'deniedCidrs.0'],
    ['a plain-http control plane', '{"controlPlaneUrl": "http://qe.corp.example"}', 'controlPlaneUrl'],
    [
      'a control plane URL with credentials',
      '{"controlPlaneUrl": "https://u:p@qe.corp.example"}',
      'controlPlaneUrl',
    ],
    ['a switch that is not true or false', '{"trustOnFirstUse": "no"}', 'trustOnFirstUse'],
    ['an http Open VSX mirror', '{"openVsxUrl": "http://vsx.corp.example"}', 'openVsxUrl'],
  ])('refuses %s, naming the file', (_label, text, problem) => {
    expect(() => readManagedSettings(linuxFile(text))).toThrow(problem);
    expect(() => readManagedSettings(linuxFile(text))).toThrow('/etc/qe-workspace/policy.json');
  });

  it('refuses an unknown registry value too', () => {
    const output = '    ControlPlaneURL2    REG_SZ    https://qe.corp.example';
    expect(() => readManagedSettings(source({ platform: 'win32', queryRegistry: () => output }))).toThrow(
      'unknown ControlPlaneURL2',
    );
  });
});

describe('withManagedSettings', () => {
  const settings = () => ({ controlPlaneUrl: 'https://qe.corp.example/' });

  it('lets the organisation’s control plane win on the desktop and in local web', () => {
    const env = { QE_CONTROL_PLANE_URL: 'https://somewhere-else.example' };
    expect(withManagedSettings(env, 'electron', settings).QE_CONTROL_PLANE_URL).toBe(
      'https://qe.corp.example/',
    );
    expect(withManagedSettings(env, 'browser', settings).QE_CONTROL_PLANE_URL).toBe(
      'https://qe.corp.example/',
    );
  });

  it('never reads them for a hosted runtime', () => {
    const read = vi.fn(settings);
    const env = { QE_MODE: 'hosted', QE_CONTROL_PLANE_URL: 'https://cp.internal' };
    expect(withManagedSettings(env, 'browser', read)).toBe(env);
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves the environment alone when the organisation sets no control plane', () => {
    const env = { QE_CONTROL_PLANE_URL: 'https://mine.example' };
    expect(withManagedSettings(env, 'electron', () => ({ deniedCidrs: ['10.0.0.0/8'] }))).toBe(env);
  });
});

describe.runIf(process.platform === 'win32')('reg.exe on this Windows machine', () => {
  it('reads a key every Windows has, in the format parseRegistryOutput expects', () => {
    const output = queryRegistry('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion');
    const values = parseRegistryOutput(output ?? '');
    expect(typeof values['ProductName']).toBe('string');
    expect(typeof values['InstallDate']).toBe('boolean'); // a REG_DWORD
  });

  it('reports a missing key as no settings', () => {
    expect(queryRegistry('HKLM\\Software\\Policies\\QEWorkspace-test-does-not-exist')).toBeUndefined();
  });
});
