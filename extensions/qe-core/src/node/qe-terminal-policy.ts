import type { QeEnvironment } from '../common/qe-environment';

/**
 * What the integrated terminal may do in this IDE (Phase 06 §6.2–6.3). Theia already validates the options a
 * frontend sends (the shell must be an executable file, sane sizes); this adds the QE rules on top.
 */
export interface TerminalPolicy {
  /** Absolute shell paths a terminal may start; `undefined` = any (desktop: the user's own machine). */
  readonly allowedShells: ReadonlySet<string> | undefined;
  /** Open terminals per IDE backend (one backend per workspace runtime). */
  readonly maxTerminals: number;
  /** A terminal no page has been attached to for this long is ended (`endWhenDetached`). */
  readonly detachedTimeoutMs: number;
  /** Defaults for the terminal environment, applied only where the request does not set them. */
  readonly envDefaults: Readonly<Record<string, string>>;
}

export const DEFAULT_SHELLS = [
  '/bin/bash',
  '/usr/bin/bash',
  '/bin/sh',
  '/usr/bin/sh',
  '/bin/zsh',
  '/usr/bin/zsh',
];
export const DEFAULT_MAX_TERMINALS = 10;
const DESKTOP_MAX_TERMINALS = 50;
export const DEFAULT_DETACHED_MINUTES = 30;

/** Environment variables (set on the runtime) can tighten the defaults; invalid values fall back to them. */
export function terminalPolicyFor(
  environment: Pick<QeEnvironment, 'mode'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): TerminalPolicy {
  const envDefaults = { TERM: 'xterm-256color', ...(env.LANG === undefined && { LANG: 'C.UTF-8' }) };
  const minutes = Number(env.QE_TERMINAL_DETACHED_MINUTES);
  const detachedTimeoutMs =
    (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : DEFAULT_DETACHED_MINUTES) *
    60_000;
  if (environment.mode === 'desktop') {
    return { allowedShells: undefined, maxTerminals: DESKTOP_MAX_TERMINALS, detachedTimeoutMs, envDefaults };
  }
  const shells = (env.QE_TERMINAL_SHELLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\/[\w./-]+$/.test(s) && !s.includes('..'));
  const max = Number(env.QE_MAX_TERMINALS);
  return {
    allowedShells: new Set(shells.length > 0 ? shells : DEFAULT_SHELLS),
    maxTerminals: Number.isInteger(max) && max >= 1 && max <= 100 ? max : DEFAULT_MAX_TERMINALS,
    detachedTimeoutMs,
    envDefaults,
  };
}

/** The subset of Theia's shell options the policy looks at. */
export interface ShellOptionsLike {
  shell?: string;
  args?: string[] | string;
  env?: { [key: string]: string | null };
}

/**
 * Applies the policy to one terminal request. A shell outside the allowlist falls back to the default shell
 * (the same behaviour Theia uses for an invalid shell) and drops its arguments, which belonged to that shell.
 */
export function applyTerminalPolicy<T extends ShellOptionsLike>(
  options: T,
  policy: TerminalPolicy,
): { options: T; rejectedShell?: string } {
  const env = { ...policy.envDefaults, ...(options.env ?? {}) };
  if (
    options.shell === undefined ||
    policy.allowedShells === undefined ||
    policy.allowedShells.has(options.shell)
  ) {
    return { options: { ...options, env } };
  }
  const rest: T = { ...options, env };
  delete rest.shell;
  delete rest.args;
  return { options: rest, rejectedShell: options.shell };
}

/** Minimal view of Theia's shell terminal server. */
export interface TerminalServerLike {
  create(options: ShellOptionsLike): Promise<number>;
}

/** Minimal view of Theia's ProcessManager: notifies when a terminal process ends. */
export type WatchExit = (terminalId: number, onExit: () => void) => void;

export interface PolicyLogger {
  warn(message: string): void;
}

/** Minimal view of Theia's TerminalProcess: each page attached to it reads its output through its own stream. */
export interface TerminalProcessLike {
  createOutputStream(): { once(event: 'close', listener: () => void): unknown };
  kill(): void;
}

/**
 * Ends a terminal once no page has been attached to it for `timeoutMs`, and returns how to stop watching (the
 * process ended). Terminals outlive page loads so that a reload reattaches, but nothing ended one a page had left for
 * good: every fresh browser session (Theia's default layout) kept one, until the limit refused all new terminals
 * (Phase 10 review; 30 minutes by the owner's decision of 2026-10-30). Theia's terminal channel reads the output
 * through a stream of its own per page and disposes it when the page goes, so those streams count the pages.
 */
export function endWhenDetached(
  terminal: TerminalProcessLike,
  timeoutMs: number,
  onEnd: () => void,
): () => void {
  let attached = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watching = true;
  const disarm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      timer = undefined;
      onEnd();
      terminal.kill();
    }, timeoutMs);
  };
  const open = terminal.createOutputStream.bind(terminal);
  terminal.createOutputStream = () => {
    const stream = open();
    attached++;
    disarm();
    stream.once('close', () => {
      attached--;
      if (attached === 0 && watching) arm();
    });
    return stream;
  };
  arm(); // until the page that asked for it attaches
  return () => {
    watching = false;
    disarm();
  };
}

/**
 * Wraps `create` on the (singleton) shell terminal server: refuses a terminal over the limit (Theia treats -1 as
 * "could not create"), applies the shell allowlist and environment defaults, ends terminals left without a page
 * (`endWhenDetached`, for the processes `findTerminal` knows), and frees a slot when the process ends.
 */
export function enforceTerminalPolicy<S extends TerminalServerLike>(
  server: S,
  policy: TerminalPolicy,
  watchExit: WatchExit,
  logger: PolicyLogger,
  findTerminal: (terminalId: number) => TerminalProcessLike | undefined = () => undefined,
): S {
  const create = server.create.bind(server);
  let open = 0;
  server.create = async (requested: ShellOptionsLike): Promise<number> => {
    if (open >= policy.maxTerminals) {
      logger.warn(`QE: terminal refused — limit of ${String(policy.maxTerminals)} open terminals reached`);
      return -1;
    }
    open++; // reserved before awaiting, so parallel requests cannot overshoot the limit
    const { options, rejectedShell } = applyTerminalPolicy(requested, policy);
    if (rejectedShell !== undefined) logger.warn('QE: shell not allowed here; using the default shell');
    let id = -1;
    try {
      id = await create(options);
    } finally {
      if (id < 0) open--;
    }
    if (id >= 0) {
      const terminal = findTerminal(id);
      const stopWatching =
        terminal === undefined
          ? undefined
          : endWhenDetached(terminal, policy.detachedTimeoutMs, () => {
              logger.warn(
                `QE: terminal ended — no page attached for ${String(policy.detachedTimeoutMs / 60_000)} min`,
              );
            });
      let released = false;
      watchExit(id, () => {
        stopWatching?.();
        if (!released) {
          released = true;
          open--;
        }
      });
    }
    return id;
  };
  return server;
}
