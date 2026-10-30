import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  adapterFor as defaultAdapterFor,
  checkRunEnv,
  checkSelector,
  Frameworks,
  type Framework,
  type RunnerAdapter,
  type RunState,
} from '@qe/runner';

import type {
  Discovery,
  QeRunnerClient,
  QeRunnerService,
  RunInfo,
  RunnerResult,
  RunOutcome,
  RunRecord,
  StartRunRequest,
} from '../common/qe-runner-protocol';
import { readHistory, readReport, recordedOutcome, runArtifacts, saveRecord } from './run-results';

export interface RunnerServiceOptions {
  /** Runs at the same time in this IDE backend (PHASE_11 §11.3: e.g. 2). */
  readonly maxConcurrent: number;
  /** A run still going after this long is cancelled. */
  readonly timeoutMs: number;
  /** Output kept in memory per run for pages that attach later; the log file has all of it. */
  readonly outputChars: number;
  /** Between SIGINT and SIGKILL when a run is cancelled. */
  readonly killGraceMs: number;
  readonly discoveryTimeoutMs: number;
}

export const DEFAULT_RUNNER_OPTIONS: RunnerServiceOptions = {
  maxConcurrent: 2,
  timeoutMs: 60 * 60_000,
  outputChars: 5 * 1024 * 1024,
  killGraceMs: 10_000,
  discoveryTimeoutMs: 60_000,
};

/** Runner limits from the runtime's environment; invalid values keep the defaults. */
export function runnerOptionsFrom(env: Readonly<Record<string, string | undefined>>): RunnerServiceOptions {
  const int = (value: string | undefined, min: number, max: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  };
  const minutes = int(env['QE_RUNNER_TIMEOUT_MIN'], 1, 24 * 60);
  return {
    ...DEFAULT_RUNNER_OPTIONS,
    maxConcurrent: int(env['QE_RUNNER_MAX_CONCURRENT'], 1, 16) ?? DEFAULT_RUNNER_OPTIONS.maxConcurrent,
    timeoutMs: minutes === undefined ? DEFAULT_RUNNER_OPTIONS.timeoutMs : minutes * 60_000,
  };
}

/**
 * What a test process inherits from the backend: where programs and the user's files are, language and time zone,
 * the temporary folder, the OS's own variables on Windows, and the toolchains' homes. Nothing else — the backend's
 * environment is not the test's business (07_SECURITY T17).
 */
const INHERITED = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'JAVA_HOME',
  'MAVEN_HOME',
];

export function runEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  requested: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && INHERITED.includes(name.toUpperCase())) env[name] = value;
  }
  // No bytecode files left in the project, and output as it happens rather than at exit.
  return { ...env, ...checkRunEnv(requested), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
}

/** The project's own virtual environment if it has one (`.venv`), else the system's Python. */
export async function pythonFor(root: string, platform: NodeJS.Platform): Promise<string> {
  const venv =
    platform === 'win32'
      ? join(root, '.venv', 'Scripts', 'python.exe')
      : join(root, '.venv', 'bin', 'python');
  const found = await stat(venv).then(
    (s) => s.isFile(),
    () => false,
  );
  return found ? venv : platform === 'win32' ? 'python' : 'python3';
}

export interface RunnerServiceDeps {
  readonly options?: RunnerServiceOptions;
  readonly spawn?: typeof nodeSpawn;
  readonly adapterFor?: (framework: Framework) => RunnerAdapter;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether the interpreter has pytest-html (tests replace the probe). */
  readonly hasHtmlReport?: (python: string, root: string) => Promise<boolean>;
  readonly log?: { warn(message: string): void };
}

interface Run {
  readonly root: string;
  /** The files the run may write, relative to the project folder. */
  readonly files: { readonly junit: string; readonly htmlReport?: string; readonly log: string };
  readonly info: RunInfo;
  readonly child: ChildProcess;
  readonly startedMs: number;
  readonly folder: string;
  readonly logFile: WriteStream;
  output: string[];
  outputLength: number;
  state: RunState;
  cancelled: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

const fail = <T>(code: string, message?: string): RunnerResult<T> => ({
  ok: false,
  code,
  ...(message !== undefined && { message }),
});

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/**
 * Runs tests in a project folder of this IDE (PHASE_11 §11.3): the framework's adapter builds the command, which is
 * started with `spawn(file, args, { shell: false })` in a process group of its own, so that cancelling stops pytest
 * and whatever it started: SIGINT first (pytest writes its results), SIGKILL after the grace time. Output goes to
 * every connected page and to `.qe-runs/<runId>/output.log`; the last `outputChars` are kept for pages that come
 * later. One instance per IDE backend, so the limit counts every page's runs.
 */
export class RunnerService implements QeRunnerService {
  protected readonly clients = new Set<QeRunnerClient>();
  protected readonly runs = new Map<string, Run>();
  protected readonly options: RunnerServiceOptions;
  protected readonly spawnProcess: typeof nodeSpawn;
  protected readonly adapterFor: (framework: Framework) => RunnerAdapter;
  protected readonly platform: NodeJS.Platform;

  constructor(protected readonly deps: RunnerServiceDeps = {}) {
    this.options = deps.options ?? DEFAULT_RUNNER_OPTIONS;
    this.spawnProcess = deps.spawn ?? nodeSpawn;
    this.adapterFor = deps.adapterFor ?? defaultAdapterFor;
    this.platform = deps.platform ?? process.platform;
  }

  /** RPC servers get one client per connection; every connected page hears every run. */
  setClient(client: QeRunnerClient | undefined): void {
    if (client !== undefined) this.clients.add(client);
  }

  removeClient(client: QeRunnerClient): void {
    this.clients.delete(client);
  }

  dispose(): void {
    for (const run of this.runs.values()) this.stop(run);
  }

  async discover(root: string, framework: Framework): Promise<RunnerResult<Discovery>> {
    if (!Frameworks.includes(framework)) return fail('INVALID_REQUEST', 'framework: not supported');
    if (!isAbsolute(root) || !(await isDirectory(root))) return fail('NOT_FOUND', 'root: not a folder');
    const adapter = this.adapterFor(framework);
    const command = adapter.discoverCommand({ python: await pythonFor(root, this.platform) });
    return new Promise((done) => {
      let stdout = '';
      const child = this.spawnProcess(command.file, [...command.args], {
        cwd: resolve(root, command.cwd),
        env: runEnvironment(this.deps.env ?? process.env, undefined),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), this.options.discoveryTimeoutMs);
      const collect = (chunk: Buffer) => {
        // Enough for tens of thousands of test ids; the rest is ignored.
        if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8');
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', () => {
        clearTimeout(timer);
        done(fail('INTERNAL_ERROR', `${command.file} could not be started`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const nodes = adapter.parseDiscovery(stdout);
        const complete = code === 0 || (code === 5 && nodes.length === 0);
        done({
          ok: true,
          value: { nodes, ...(!complete && { problem: stdout.slice(-2000) }) },
        });
      });
    });
  }

  async start(root: string, request: StartRunRequest): Promise<RunnerResult<RunInfo>> {
    if (!Frameworks.includes(request.framework)) return fail('INVALID_REQUEST', 'framework: not supported');
    let selector;
    let env;
    try {
      selector = checkSelector(request.selector);
      env = runEnvironment(this.deps.env ?? process.env, request.env);
    } catch (error) {
      return fail('INVALID_REQUEST', error instanceof Error ? error.message : undefined);
    }
    if (!isAbsolute(root) || !(await isDirectory(root))) return fail('NOT_FOUND', 'root: not a folder');
    if (this.runs.size >= this.options.maxConcurrent) {
      return fail('QUOTA_EXCEEDED', `at most ${String(this.options.maxConcurrent)} runs at a time`);
    }
    const adapter = this.adapterFor(request.framework);
    const runId = randomUUID();
    const python = await pythonFor(root, this.platform);
    const htmlReport = (await this.deps.hasHtmlReport?.(python, root)) ?? false;
    const command = adapter.buildCommand(selector, { runId, python, htmlReport });
    const folder = adapter.resultFiles({ runId }).junit.replace(/\/[^/]+$/, '');
    // Re-checked after the awaits: two pages may have started runs meanwhile.
    if (this.runs.size >= this.options.maxConcurrent) {
      return fail('QUOTA_EXCEEDED', `at most ${String(this.options.maxConcurrent)} runs at a time`);
    }
    await mkdir(join(root, folder), { recursive: true });
    const child = this.spawnProcess(command.file, [...command.args], {
      cwd: resolve(root, command.cwd),
      env,
      shell: false,
      // A process group of its own (POSIX), so a cancel reaches everything the tests started.
      detached: this.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const info: RunInfo = {
      runId,
      framework: request.framework,
      selector,
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
    };
    const run: Run = {
      info,
      child,
      startedMs: Date.now(),
      folder,
      root,
      files: { ...adapter.resultFiles({ runId }), log: `${folder}/output.log` },
      logFile: createWriteStream(join(root, folder, 'output.log')),
      output: [],
      outputLength: 0,
      state: 'RUNNING',
      cancelled: false,
      timers: [],
    };
    this.runs.set(runId, run);
    run.timers.push(
      setTimeout(() => {
        this.append(
          run,
          `\n[QE: the run took longer than ${String(this.options.timeoutMs / 60_000)} min and was cancelled]\n`,
        );
        this.stop(run);
      }, this.options.timeoutMs),
    );
    child.stdout.on('data', (chunk: Buffer) => {
      this.append(run, chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.append(run, chunk.toString('utf8'));
    });
    let finished = false;
    const finish = (state: RunState, exitCode: number | undefined) => {
      if (finished) return;
      finished = true;
      this.finish(run, state, exitCode);
    };
    child.on('error', () => {
      this.append(run, `[QE: ${command.file} could not be started — is it installed?]\n`);
      finish('ERROR', undefined);
    });
    child.on('close', (code) => {
      finish(
        run.cancelled ? 'CANCELLED' : code === null ? 'ERROR' : adapter.stateOf(code),
        code ?? undefined,
      );
    });
    return { ok: true, value: info };
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run !== undefined) this.stop(run);
    return Promise.resolve();
  }

  async running(): Promise<{ run: RunInfo; output: string }[]> {
    return Promise.resolve([...this.runs.values()].map((r) => ({ run: r.info, output: r.output.join('') })));
  }

  /** SIGINT to the run's process group, SIGKILL after the grace time if it is still there. */
  protected stop(run: Run): void {
    if (run.cancelled) return;
    run.cancelled = true;
    this.signal(run, 'SIGINT');
    run.timers.push(
      setTimeout(() => {
        this.signal(run, 'SIGKILL');
      }, this.options.killGraceMs),
    );
  }

  /**
   * Signals the run's process group (POSIX) or its process (Windows). `afterExit`: also once the test process itself
   * has ended — what it started may still be in the group.
   */
  protected signal(run: Run, signal: NodeJS.Signals, afterExit = false): void {
    const pid = run.child.pid;
    const exited = run.child.exitCode !== null || run.child.signalCode !== null;
    if (pid === undefined || (exited && (!afterExit || this.platform === 'win32'))) return;
    try {
      if (this.platform === 'win32') run.child.kill(signal);
      else process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  }

  protected append(run: Run, text: string): void {
    run.logFile.write(text);
    run.output.push(text);
    run.outputLength += text.length;
    while (run.outputLength > this.options.outputChars && run.output.length > 1) {
      run.outputLength -= run.output.shift()?.length ?? 0;
    }
    for (const client of this.clients) client.onOutput(run.info.runId, text);
  }

  protected finish(run: Run, state: RunState, exitCode: number | undefined): void {
    for (const timer of run.timers) clearTimeout(timer);
    // Nothing of a run outlives it: a server or browser a test started and left is ended with it (T16).
    this.signal(run, 'SIGKILL', true);
    run.state = state;
    this.runs.delete(run.info.runId);
    const durationMs = Date.now() - run.startedMs;
    this.complete(run, state, exitCode, durationMs).catch((error: unknown) => {
      const kind = error instanceof Error ? error.name : 'error';
      this.deps.log?.warn(`QE runner: run ${run.info.runId} could not be recorded (${kind})`);
    });
  }

  /** Reads the report, describes the run's files, saves `run.json`, then tells the pages. */
  protected async complete(
    run: Run,
    state: RunState,
    exitCode: number | undefined,
    durationMs: number,
  ): Promise<void> {
    await new Promise<void>((done) => run.logFile.end(done));
    const report = await readReport(join(run.root, run.files.junit));
    const outcome: RunOutcome = {
      state,
      ...(exitCode !== undefined && { exitCode }),
      durationMs,
      folder: run.folder,
      log: run.files.log,
      ...report,
      artifacts: await runArtifacts(run.root, run.files),
    };
    const recorded = recordedOutcome(outcome);
    await saveRecord(run.root, { run: { ...run.info, state }, outcome: recorded });
    for (const client of this.clients) client.onFinished(run.info.runId, recorded);
  }

  async history(root: string, limit: number): Promise<RunnerResult<RunRecord[]>> {
    if (!isAbsolute(root) || !(await isDirectory(root))) return fail('NOT_FOUND', 'root: not a folder');
    return { ok: true, value: await readHistory(root, Math.min(Math.max(Math.trunc(limit), 1), 100)) };
  }
}
