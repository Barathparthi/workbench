import { createHash } from 'node:crypto';

import type { TestRunResultRequest, TestSelectorRecord } from '@qe/contracts';
import {
  adapterFor,
  mergeResults,
  parseJUnit,
  type Framework,
  type RunFiles,
  type RunnerAdapter,
  type RunResults,
  type RunState,
} from '@qe/runner';

import { isDomainError } from '@qe/domain';
import { remoteCancelCommand, remoteRunCommand } from './remote-exec.js';
import type { SftpChannel } from './sftp.js';
import type { ExecChannel, PtyChannel, SshConnection } from './ssh-transport.js';
import type { TerminalBridge } from './terminal-bridge.js';

/** A run as the control plane (or the desktop app) hands it over: data, never a command line. */
export interface RemoteRunSpec {
  readonly runId: string;
  readonly framework: Framework;
  readonly selector: TestSelectorRecord;
}

export interface RemoteRunOutcome {
  /** As recorded: every count, at most 200 failures, the run's files with their sha256. */
  readonly result: TestRunResultRequest;
  /** Why no report was read (none written, too large, malformed). */
  readonly problem?: string;
}

/** Reports larger than this are not read (a broker holds them in memory to hash and parse). */
export const MAX_REMOTE_REPORT_BYTES = 50 * 1024 * 1024;
const MAX_FAILURES = 200;
const MAX_TEXT = 4096;
const NO_COUNTS = { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 };

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** A file of the run's folder on the target: its bytes, or why not. */
async function readRunFile(
  sftp: SftpChannel,
  path: string,
): Promise<{ data: Buffer } | { missing: true } | { problem: string }> {
  try {
    return { data: (await sftp.readFile(path, MAX_REMOTE_REPORT_BYTES)).data };
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') return { missing: true };
    if (isDomainError(error) && error.code === 'REMOTE_FILE_TOO_LARGE') {
      return { problem: 'the JUnit report is larger than 50 MB and was not read' };
    }
    return { problem: 'the JUnit report could not be read' };
  }
}

/** Report files read for one remote run (Surefire writes one per test class). */
const MAX_REMOTE_REPORTS = 2_000;

/**
 * The run's reports on the target, read over SFTP: its one JUnit report (pytest, kept as an artifact with its sha256),
 * or the Surefire reports in `target/surefire-reports` written during the run — those modified since the run's
 * `pid` file, by the target's own clock — merged. Those stay where Maven wrote them: counts and failures only.
 */
async function readReports(
  sftp: SftpChannel,
  root: string,
  files: RunFiles,
): Promise<{ results?: RunResults; problem?: string; artifacts: TestRunResultRequest['artifacts'] }> {
  if (files.junit !== undefined) {
    const report = await readRunFile(sftp, `${root}/${files.junit}`);
    if (!('data' in report)) {
      return {
        problem: 'problem' in report ? report.problem : 'the run wrote no JUnit report',
        artifacts: [],
      };
    }
    const artifacts: TestRunResultRequest['artifacts'] = [
      { kind: 'junit_xml', path: files.junit, sizeBytes: report.data.length, sha256: sha256(report.data) },
    ];
    try {
      return { results: parseJUnit(report.data.toString('utf8')), artifacts };
    } catch {
      return { problem: 'the JUnit report is not well-formed XML', artifacts };
    }
  }
  if (files.reports === undefined) return { problem: 'the run wrote no JUnit report', artifacts: [] };
  const since = await sftp.stat(`${root}/${files.folder}/pid`).then(
    (s) => s.mtimeMs,
    () => undefined,
  );
  const folder = `${root}/${files.reports.folder}`;
  const listed = await sftp.readdir(folder, MAX_REMOTE_REPORTS).catch(() => ({ entries: [] }));
  const fresh = listed.entries
    .filter(
      (e) =>
        e.stats.kind === 'file' &&
        files.reports?.pattern.test(e.name) === true &&
        // A second of slack: SFTP modification times have whole seconds.
        since !== undefined &&
        e.stats.mtimeMs >= since - 1_000,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (fresh.length === 0) return { problem: 'the run wrote no test reports', artifacts: [] };
  if (fresh.reduce((sum, e) => sum + e.stats.size, 0) > MAX_REMOTE_REPORT_BYTES) {
    return { problem: 'the reports are larger than 50 MB and were not read', artifacts: [] };
  }
  const parsed: RunResults[] = [];
  let unreadable = 0;
  for (const entry of fresh) {
    const read = await readRunFile(sftp, `${folder}/${entry.name}`);
    try {
      if (!('data' in read)) throw new Error('unread');
      parsed.push(parseJUnit(read.data.toString('utf8')));
    } catch {
      unreadable++;
    }
  }
  return {
    ...(parsed.length > 0 && { results: mergeResults(parsed) }),
    ...(unreadable > 0 && { problem: `${String(unreadable)} of the reports could not be read` }),
    artifacts: [],
  };
}

/**
 * How a remote run ended, from its exit and the reports it left (PHASE_11 §11.4–11.5): read over SFTP and parsed,
 * with the sha256 of the files kept in `<root>/.qe-runs/<runId>/`. A failed exit without a report is the run's own
 * failure (it did not build, or could not start), not failing tests: ERROR.
 */
export async function readRemoteRun(
  sftp: SftpChannel,
  root: string,
  spec: RemoteRunSpec,
  exit: { readonly code: number | null; readonly cancelled: boolean; readonly durationMs: number },
  adapter: RunnerAdapter = adapterFor(spec.framework),
): Promise<RemoteRunOutcome> {
  const files = adapter.resultFiles({ runId: spec.runId });
  const read = await readReports(sftp, root, files);
  const exited: RunState = exit.cancelled
    ? 'CANCELLED'
    : exit.code === null
      ? 'ERROR'
      : adapter.stateOf(exit.code);
  const state = exited === 'FAILED' && read.results === undefined ? 'ERROR' : exited;
  const artifacts = [...read.artifacts];
  if (read.results !== undefined && files.htmlReport !== undefined) {
    const html = await readRunFile(sftp, `${root}/${files.htmlReport}`);
    if ('data' in html) {
      artifacts.push({
        kind: 'html_report',
        path: files.htmlReport,
        sizeBytes: html.data.length,
        sha256: sha256(html.data),
      });
    }
  }
  const base = {
    state: state as TestRunResultRequest['state'],
    ...(exit.code !== null && { exitCode: exit.code }),
    durationMs: Math.max(0, Math.round(exit.durationMs)),
  };
  const problem = read.problem === undefined ? {} : { problem: read.problem };
  if (read.results === undefined) {
    return { result: { ...base, counts: NO_COUNTS, failures: [], truncated: false, artifacts }, ...problem };
  }
  const parsed = read.results;
  const failed = parsed.cases.filter((c) => c.status === 'failed' || c.status === 'error');
  return {
    result: {
      ...base,
      counts: parsed.counts,
      failures: failed.slice(0, MAX_FAILURES).map((c) => ({
        id: c.id.slice(0, 1024),
        name: c.name.slice(0, 1024),
        status: c.status === 'error' ? ('error' as const) : ('failed' as const),
        ...(c.file !== undefined && { file: c.file.slice(0, 1024) }),
        ...(c.line !== undefined && c.line >= 1 && { line: c.line }),
        ...((c.message ?? c.stack) !== undefined && {
          message: (c.message ?? c.stack ?? '').slice(0, MAX_TEXT),
        }),
      })),
      truncated: parsed.truncated || failed.length > MAX_FAILURES,
      artifacts,
    },
    ...problem,
  };
}

export interface RemoteRunOptions {
  readonly connection: SshConnection;
  readonly sftp: SftpChannel;
  /** The target's folder (`remoteRoot`, or the user's home for a personal host). */
  readonly root: string;
  readonly spec: RemoteRunSpec;
  /** The stream to the IDE: output frames, the `run` result, the close. */
  readonly bridge: TerminalBridge;
  /** Records the outcome (the control plane, or the desktop app's history) before the IDE is told. */
  readonly record: (outcome: RemoteRunOutcome) => Promise<void>;
  /** Between INT and KILL when the run is cancelled. */
  readonly killGraceMs?: number;
  readonly now?: () => number;
}

/** Runs one short command (a cancel) and waits for it to end, at most 10 s. */
async function runOnce(connection: SshConnection, command: string): Promise<void> {
  const channel = await connection.exec(command);
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      channel.close();
      done();
    }, 10_000);
    channel.onClose(() => {
      clearTimeout(timer);
      done();
    });
  });
}

/**
 * A test run on the target, streamed through the IDE's bridge (PHASE_11 §11.4). The adapter's argv runs through
 * `remoteRunCommand`; the exec channel is attached to the bridge as its "PTY", so output, backpressure, idle and
 * expiry work as for a terminal. Anything that ends the stream early — the IDE's Cancel (SIGINT), the page going
 * away, a revoke, the idle or session limit — cancels the run: INT to its process group, KILL after the grace time.
 * When the run ends, its report is read and recorded first, then the IDE gets the `run` result and the stream
 * closes. Resolves with the outcome once all of that is done.
 */
export async function runRemoteTests(options: RemoteRunOptions): Promise<RemoteRunOutcome> {
  const { connection, sftp, root, spec, bridge } = options;
  const now = options.now ?? Date.now;
  const adapter = adapterFor(spec.framework);
  // The project's own virtual environment if it has one, as in the IDE backend.
  const venv = await sftp.stat(`${root}/.venv/bin/python`).then(
    (s) => s.kind === 'file',
    () => false,
  );
  const command = adapter.buildCommand(spec.selector, {
    runId: spec.runId,
    python: venv ? '.venv/bin/python' : 'python3',
    // The project's Maven wrapper when it has one.
    tool: (await sftp.stat(`${root}/mvnw`).then(
      (st) => st.kind === 'file',
      () => false,
    ))
      ? './mvnw'
      : 'mvn',
    htmlReport: false,
  });
  const exec: ExecChannel = await connection.exec(remoteRunCommand({ root, runId: spec.runId, command }));
  const started = now();
  let cancelled = false;
  let ended = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (cancelled || ended) return;
    cancelled = true;
    void runOnce(connection, remoteCancelCommand(root, spec.runId, 'INT')).catch(() => undefined);
    killTimer = setTimeout(() => {
      if (!ended)
        void runOnce(connection, remoteCancelCommand(root, spec.runId, 'KILL')).catch(() => undefined);
    }, options.killGraceMs ?? 10_000);
  };
  let closeListener: ((code: number | null, signal: string | null) => void) | undefined;
  const channel: PtyChannel = {
    // An exec run reads no input; the bridge's interrupt (Ctrl+C, 0x03) is the IDE's Cancel.
    write: (data) => {
      if (data.includes(0x03)) cancel();
    },
    setWindow: () => undefined,
    pause: () => {
      exec.pause();
    },
    resume: () => {
      exec.resume();
    },
    // The bridge closes it when the stream ends for any reason: stop the run on the target.
    end: cancel,
    onData: (listener) => {
      exec.onData(listener);
    },
    onClose: (listener) => {
      closeListener = listener;
    },
  };
  const outcome = new Promise<RemoteRunOutcome>((resolve) => {
    exec.onClose((code, signal) => {
      ended = true;
      clearTimeout(killTimer);
      void (async () => {
        const result = await readRemoteRun(
          sftp,
          root,
          spec,
          { code, cancelled, durationMs: now() - started },
          adapter,
        );
        await options.record(result).catch(() => undefined);
        bridge.sendControl({
          t: 'run',
          result: result.result,
          ...(result.problem !== undefined && { problem: result.problem }),
        });
        closeListener?.(code, signal);
        resolve(result);
      })();
    });
  });
  bridge.attach(channel);
  return outcome;
}
