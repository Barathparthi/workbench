import { EventEmitter } from 'node:events';

import { ILogger } from '@theia/core/lib/common/logger';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { IShellTerminalServer } from '@theia/terminal/lib/common/shell-terminal-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindQeTerminalPolicy } from '../qe-core-backend-module';
import {
  applyTerminalPolicy,
  DEFAULT_DETACHED_MINUTES,
  DEFAULT_MAX_TERMINALS,
  DEFAULT_SHELLS,
  endWhenDetached,
  enforceTerminalPolicy,
  terminalPolicyFor,
  type ShellOptionsLike,
  type TerminalPolicy,
} from '../qe-terminal-policy';

const hosted = { mode: 'hosted' as const };

describe('terminalPolicyFor', () => {
  it('restricts hosted and local-web IDEs to the default shells and 10 terminals', () => {
    for (const mode of ['hosted', 'local-web'] as const) {
      const p = terminalPolicyFor({ mode }, {});
      expect([...(p.allowedShells ?? [])]).toEqual(DEFAULT_SHELLS);
      expect(p.maxTerminals).toBe(DEFAULT_MAX_TERMINALS);
    }
  });

  it('leaves the desktop (the user’s own machine) unrestricted apart from a generous limit', () => {
    const p = terminalPolicyFor({ mode: 'desktop' }, { QE_TERMINAL_SHELLS: '/bin/sh' });
    expect(p.allowedShells).toBeUndefined();
    expect(p.maxTerminals).toBe(50);
  });

  it('takes the allowlist and limit from the runtime environment, ignoring unsafe or invalid values', () => {
    const p = terminalPolicyFor(hosted, {
      QE_TERMINAL_SHELLS: '/bin/bash, bash, /tmp/../bin/sh, /usr/local/bin/fish',
      QE_MAX_TERMINALS: '3',
    });
    expect([...(p.allowedShells ?? [])]).toEqual(['/bin/bash', '/usr/local/bin/fish']);
    expect(p.maxTerminals).toBe(3);
    for (const bad of ['0', '101', '2.5', 'many']) {
      expect(terminalPolicyFor(hosted, { QE_MAX_TERMINALS: bad }).maxTerminals).toBe(DEFAULT_MAX_TERMINALS);
    }
  });

  it('sets TERM always and LANG only when the runtime has none', () => {
    expect(terminalPolicyFor(hosted, {}).envDefaults).toEqual({ TERM: 'xterm-256color', LANG: 'C.UTF-8' });
    expect(terminalPolicyFor(hosted, { LANG: 'de_DE.UTF-8' }).envDefaults).toEqual({
      TERM: 'xterm-256color',
    });
  });
});

describe('applyTerminalPolicy', () => {
  const policy = terminalPolicyFor(hosted, {});

  it('keeps allowed shells and merges environment defaults under the request', () => {
    const r = applyTerminalPolicy({ shell: '/bin/bash', args: ['-l'], env: { TERM: 'xterm' } }, policy);
    expect(r).toEqual({
      options: { shell: '/bin/bash', args: ['-l'], env: { TERM: 'xterm', LANG: 'C.UTF-8' } },
    });
  });

  it('replaces a shell outside the allowlist with the default and drops its arguments', () => {
    const r = applyTerminalPolicy({ shell: '/usr/bin/python3', args: ['-c', 'import os'] }, policy);
    expect(r.rejectedShell).toBe('/usr/bin/python3');
    expect(r.options).toEqual({ env: { TERM: 'xterm-256color', LANG: 'C.UTF-8' } });
  });

  it('leaves the default shell (no shell given) alone', () => {
    expect(applyTerminalPolicy({}, policy).rejectedShell).toBeUndefined();
  });
});

describe('enforceTerminalPolicy', () => {
  const policy: TerminalPolicy = {
    allowedShells: new Set(['/bin/bash']),
    maxTerminals: 2,
    detachedTimeoutMs: 60_000,
    envDefaults: {},
  };

  function setup(createResult: (o: ShellOptionsLike) => Promise<number> = () => Promise.resolve(nextId++)) {
    const exits = new Map<number, () => void>();
    const warn = vi.fn<(m: string) => void>();
    const seen: ShellOptionsLike[] = [];
    const server = {
      create: (o: ShellOptionsLike) => {
        seen.push(o);
        return createResult(o);
      },
    };
    enforceTerminalPolicy(server, policy, (id, onExit) => exits.set(id, onExit), { warn });
    return { server, exits, warn, seen };
  }
  let nextId = 1;

  it('refuses terminals over the limit and frees a slot when one exits', async () => {
    const { server, exits, warn } = setup();
    const a = await server.create({});
    await server.create({});
    expect(await server.create({})).toBe(-1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('limit of 2'));
    exits.get(a)?.();
    exits.get(a)?.(); // exit and close both fire: released once
    expect(await server.create({})).toBeGreaterThan(0);
    expect(await server.create({})).toBe(-1);
  });

  it('does not overshoot the limit with parallel requests', async () => {
    const { server } = setup();
    const ids = await Promise.all([
      server.create({}),
      server.create({}),
      server.create({}),
      server.create({}),
    ]);
    expect(ids.filter((id) => id < 0)).toHaveLength(2);
  });

  it('frees the slot when Theia fails to create the terminal', async () => {
    let fail = true;
    const { server } = setup(() => Promise.resolve(fail ? -1 : nextId++));
    expect(await server.create({})).toBe(-1);
    expect(await server.create({})).toBe(-1);
    fail = false;
    expect(await server.create({})).toBeGreaterThan(0);
    expect(await server.create({})).toBeGreaterThan(0);
  });

  it('passes sanitised options to Theia and warns about refused shells without naming them', async () => {
    const { server, seen, warn } = setup();
    await server.create({ shell: '/usr/bin/nc', args: ['-l', '4444'] });
    expect(seen[0]).toEqual({ env: {} });
    expect(warn.mock.calls[0]?.[0]).not.toContain('/usr/bin/nc');
  });
});

describe('bindQeTerminalPolicy', () => {
  it('decorates the shell terminal server Theia binds', async () => {
    const container = new Container();
    const created: ShellOptionsLike[] = [];
    container.load(
      new ContainerModule((bind, _u, _i, _r, _ua, onActivation) => {
        bind(IShellTerminalServer).toConstantValue({
          create: (o: ShellOptionsLike) => {
            created.push(o);
            return Promise.resolve(7);
          },
        });
        bind(ProcessManager).toConstantValue({ get: () => undefined } as unknown as ProcessManager);
        bind(ILogger).toConstantValue({ warn: () => Promise.resolve() });
        bindQeTerminalPolicy(onActivation, hosted, {});
      }),
    );
    const server = container.get<{ create(o: ShellOptionsLike): Promise<number> }>(IShellTerminalServer);
    expect(await server.create({ shell: '/usr/bin/perl' })).toBe(7);
    expect(created[0]).toEqual({ env: { TERM: 'xterm-256color', LANG: 'C.UTF-8' } });
  });
});

describe('terminals left without a page', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeTerminal() {
    const streams: EventEmitter[] = [];
    const kill = vi.fn<() => void>();
    const terminal = {
      createOutputStream: () => {
        const stream = new EventEmitter();
        streams.push(stream);
        return stream;
      },
      kill,
    };
    // A page attaches (Theia's terminal channel opens a stream) and leaves (the channel disposes it).
    const attach = () => terminal.createOutputStream();
    return { terminal, attach, kill, leave: (s: EventEmitter) => s.emit('close') };
  }

  it('waits 30 minutes by default, or what the runtime sets (1 min to 24 h)', () => {
    expect(DEFAULT_DETACHED_MINUTES).toBe(30);
    expect(terminalPolicyFor(hosted, {}).detachedTimeoutMs).toBe(30 * 60_000);
    expect(terminalPolicyFor({ mode: 'desktop' }, {}).detachedTimeoutMs).toBe(30 * 60_000);
    expect(terminalPolicyFor(hosted, { QE_TERMINAL_DETACHED_MINUTES: '5' }).detachedTimeoutMs).toBe(
      5 * 60_000,
    );
    for (const bad of ['0', '1441', '1.5', 'never'])
      expect(terminalPolicyFor(hosted, { QE_TERMINAL_DETACHED_MINUTES: bad }).detachedTimeoutMs).toBe(
        30 * 60_000,
      );
  });

  it('ends a terminal no page ever attached to', () => {
    vi.useFakeTimers();
    const { terminal, kill } = fakeTerminal();
    const ended = vi.fn();
    endWhenDetached(terminal, 60_000, ended);
    vi.advanceTimersByTime(59_999);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ended).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
  });

  it('keeps it while a page is attached and through a reload, and ends it once the last page has been gone that long', () => {
    vi.useFakeTimers();
    const { terminal, attach, leave, kill } = fakeTerminal();
    endWhenDetached(terminal, 60_000, () => undefined);
    const first = attach();
    const second = attach();
    vi.advanceTimersByTime(10 * 60_000);
    leave(first);
    vi.advanceTimersByTime(10 * 60_000);
    expect(kill).not.toHaveBeenCalled(); // the second page is still there
    leave(second);
    vi.advanceTimersByTime(30_000);
    leave(attach()); // a reload: the page comes back, then goes again
    vi.advanceTimersByTime(59_999);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledOnce();
  });

  it('stops watching once the process has ended', () => {
    vi.useFakeTimers();
    const { terminal, attach, leave, kill } = fakeTerminal();
    const stop = endWhenDetached(terminal, 60_000, () => undefined);
    const page = attach();
    stop();
    leave(page); // the channel closes because the process ended
    vi.advanceTimersByTime(10 * 60_000);
    expect(kill).not.toHaveBeenCalled();
  });

  it('is applied to every terminal the policy lets through, and says so when it ends one', async () => {
    vi.useFakeTimers();
    const { terminal, kill } = fakeTerminal();
    const exits = new Map<number, () => void>();
    const warn = vi.fn<(m: string) => void>();
    const server: { create(o: ShellOptionsLike): Promise<number> } = { create: () => Promise.resolve(42) };
    enforceTerminalPolicy(
      server,
      { allowedShells: undefined, maxTerminals: 1, detachedTimeoutMs: 60_000, envDefaults: {} },
      (id, onExit) => exits.set(id, onExit),
      { warn },
      (id) => (id === 42 ? terminal : undefined),
    );
    expect(await server.create({})).toBe(42);
    vi.advanceTimersByTime(60_000);
    expect(kill).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('QE: terminal ended — no page attached for 1 min');
    exits.get(42)?.(); // the kill ends the process: its slot is free again
    expect(await server.create({})).toBe(42);
  });
});
