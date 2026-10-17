import { DomainError } from '@qe/domain';
import { describe, expect, it } from 'vitest';

import { parseQeEnvironment, type QeEnvironmentIssue } from '../qe-environment-config';

const WORKSPACE_ID = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const HOSTED = {
  QE_MODE: 'hosted',
  QE_CONTROL_PLANE_URL: 'https://qe.example.corp',
  QE_WORKSPACE_ID: WORKSPACE_ID,
};

function issuesOf(
  env: Record<string, string | undefined>,
  target: 'browser' | 'electron' = 'browser',
): QeEnvironmentIssue[] {
  try {
    parseQeEnvironment(env, target);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domainError = error as DomainError;
    expect(domainError.code).toBe('INVALID_REQUEST');
    return domainError.details?.['issues'] as QeEnvironmentIssue[];
  }
  throw new Error('expected parseQeEnvironment to throw');
}

describe('parseQeEnvironment: valid configurations', () => {
  it('defaults the browser app to local web, not connected', () => {
    expect(parseQeEnvironment({}, 'browser')).toEqual({
      mode: 'local-web',
      features: { personalTargets: true, managedTargets: false, workspacePicker: false },
    });
  });

  it('treats empty variables as unset', () => {
    expect(
      parseQeEnvironment({ QE_MODE: '', QE_CONTROL_PLANE_URL: '', QE_WORKSPACE_ID: '' }, 'browser').mode,
    ).toBe('local-web');
  });

  it('accepts a hosted workspace with control plane and workspace id', () => {
    expect(parseQeEnvironment(HOSTED, 'browser')).toEqual({
      mode: 'hosted',
      controlPlaneUrl: 'https://qe.example.corp/',
      workspaceId: WORKSPACE_ID,
      features: { personalTargets: false, managedTargets: true, workspacePicker: true },
    });
  });

  it('enables managed targets in local web when a control plane is configured', () => {
    const env = parseQeEnvironment(
      { QE_MODE: 'local-web', QE_CONTROL_PLANE_URL: 'https://qe.example.corp/' },
      'browser',
    );
    expect(env.features).toEqual({ personalTargets: true, managedTargets: true, workspacePicker: false });
  });

  it.each(['http://localhost:8080', 'http://127.0.0.1:8080/', 'http://[::1]:8080'])(
    'allows plain http only for loopback control planes (%s)',
    (url) => {
      expect(parseQeEnvironment({ QE_CONTROL_PLANE_URL: url }, 'browser').controlPlaneUrl).toBe(
        new URL(url).href,
      );
    },
  );

  it('is always desktop in the Electron app', () => {
    expect(parseQeEnvironment({}, 'electron')).toEqual({
      mode: 'desktop',
      features: { personalTargets: true, managedTargets: false, workspacePicker: false },
    });
    expect(parseQeEnvironment({ QE_MODE: 'desktop' }, 'electron').mode).toBe('desktop');
  });

  it('ignores unrelated variables such as a query-string look-alike', () => {
    expect(parseQeEnvironment({ QE_MODE_OVERRIDE: 'hosted', mode: 'hosted' }, 'browser').mode).toBe(
      'local-web',
    );
  });
});

describe('parseQeEnvironment: invalid configurations fail startup', () => {
  it('rejects an unknown mode', () => {
    expect(issuesOf({ QE_MODE: 'admin' })).toEqual([
      { variable: 'QE_MODE', message: 'must be one of hosted, local-web, desktop' },
    ]);
  });

  it('rejects desktop mode in the browser app', () => {
    expect(issuesOf({ QE_MODE: 'desktop' })).toEqual([
      { variable: 'QE_MODE', message: 'desktop is only valid in the desktop app' },
    ]);
  });

  it.each(['hosted', 'local-web'])('rejects QE_MODE=%s in the Electron app', (mode) => {
    expect(issuesOf({ QE_MODE: mode }, 'electron')).toContainEqual({
      variable: 'QE_MODE',
      message: 'the desktop app always runs in desktop mode',
    });
  });

  it('requires control plane and workspace id in hosted mode, reporting both', () => {
    expect(issuesOf({ QE_MODE: 'hosted' })).toEqual([
      { variable: 'QE_CONTROL_PLANE_URL', message: 'is required in hosted mode' },
      { variable: 'QE_WORKSPACE_ID', message: 'is required in hosted mode' },
    ]);
  });

  it.each([
    ['local-web', 'browser'],
    ['desktop', 'electron'],
  ] as const)('rejects a workspace id outside hosted mode (%s)', (mode, target) => {
    expect(issuesOf({ QE_MODE: mode, QE_WORKSPACE_ID: WORKSPACE_ID }, target)).toEqual([
      { variable: 'QE_WORKSPACE_ID', message: 'is only valid in hosted mode' },
    ]);
  });

  it('rejects a workspace id that is not a UUID', () => {
    expect(issuesOf({ ...HOSTED, QE_WORKSPACE_ID: '../../etc' })).toEqual([
      { variable: 'QE_WORKSPACE_ID', message: 'must be a UUID' },
    ]);
  });

  it.each([
    ['not a url', 'must be an absolute URL'],
    ['/relative/path', 'must be an absolute URL'],
    ['http://qe.example.corp', 'must use https (http only for localhost)'],
    ['ftp://qe.example.corp', 'must use https (http only for localhost)'],
    ['javascript:alert(1)', 'must use https (http only for localhost)'],
    ['https://user:secret@qe.example.corp', 'must not contain credentials'],
    ['https://qe.example.corp/?mode=hosted', 'must not contain a query or fragment'],
    ['https://qe.example.corp/#x', 'must not contain a query or fragment'],
  ])('rejects control plane URL %s', (url, message) => {
    expect(issuesOf({ QE_CONTROL_PLANE_URL: url })).toEqual([{ variable: 'QE_CONTROL_PLANE_URL', message }]);
  });

  it('never echoes configured values in the error', () => {
    try {
      parseQeEnvironment(
        { ...HOSTED, QE_CONTROL_PLANE_URL: 'https://user:s3cr3t-canary@qe.example.corp' },
        'browser',
      );
      expect.unreachable();
    } catch (error) {
      expect(
        JSON.stringify({ message: (error as Error).message, details: (error as DomainError).details }),
      ).not.toContain('s3cr3t-canary');
    }
  });
});
