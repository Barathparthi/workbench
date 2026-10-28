import { CommandRegistry } from '@theia/core/lib/common/command';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QeEnvironment, QeMode } from '../../common/qe-environment';
import { QE_SIGN_OUT, QeUserStatusContribution } from '../qe-user-status';

function contribution(mode: QeMode) {
  const c = new QeUserStatusContribution();
  const statusBar = { setElement: vi.fn(() => Promise.resolve()) };
  const environment = { mode, features: {} } as QeEnvironment;
  Object.assign(c, {
    statusBar,
    environmentService: { getEnvironment: () => Promise.resolve(environment) },
    logger: { warn: vi.fn() },
  });
  const registry = new CommandRegistry({ getContributions: () => [] });
  c.registerCommands(registry);
  return { c, registry, statusBar };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QE: Sign Out (hosted sign-in)', () => {
  it('is offered in hosted mode only: local web has no sign-in, the desktop app its own', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ username: 'bob', displayName: 'Bob', roles: ['qe.user'] }), {
            status: 200,
          }),
        ),
      ),
    );
    for (const mode of ['local-web', 'desktop'] as const) {
      const { c, registry, statusBar } = contribution(mode);
      expect(registry.isVisible(QE_SIGN_OUT.id)).toBe(false);
      c.onStart();
      await vi.waitFor(() => {
        expect(registry.isEnabled(QE_SIGN_OUT.id)).toBe(false);
      });
      expect(registry.isVisible(QE_SIGN_OUT.id)).toBe(false);
      expect(statusBar.setElement).not.toHaveBeenCalled();
    }
    const { c, registry } = contribution('hosted');
    c.onStart();
    await vi.waitFor(() => {
      expect(registry.isVisible(QE_SIGN_OUT.id)).toBe(true);
    });
    expect(registry.isEnabled(QE_SIGN_OUT.id)).toBe(true);
  });
});
