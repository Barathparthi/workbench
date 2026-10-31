import { DomainError } from '@qe/domain';
import { checkRunEnv, checkRunId, projectPath, type RunCommand } from '@qe/runner';

/**
 * Remote exec (PHASE_11 §11.4, CLAUDE.md rule 6). SSH runs a command as one string, which the target's shell parses,
 * so an argv becomes a string here and nowhere else: every element in single quotes, a quote inside it as `'\''`.
 * POSIX `sh` treats everything between single quotes literally — `;`, `$()`, backticks, newlines, globs — so each
 * element reaches the program as exactly one argument. NUL cannot be passed in an argument at all and is refused.
 */
export function shellQuote(arg: string): string {
  if (arg.includes('\0')) throw new DomainError('INVALID_REQUEST', 'an argument contains NUL');
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** An argv as one POSIX shell command line, each element quoted (`shellQuote`). */
export function shellCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new DomainError('INVALID_REQUEST', 'no command');
  return argv.map(shellQuote).join(' ');
}

/** The remote folder a run happens in: an absolute POSIX path, as the target's `remoteRoot` is. */
function remoteFolder(root: string): string {
  if (!root.startsWith('/') || root.includes('\0') || root.length > 4096) {
    throw new DomainError('INVALID_REQUEST', 'remoteRoot: not an absolute path');
  }
  return root;
}

export interface RemoteRun {
  /** The target's remote folder (its `remoteRoot`); the run's paths are relative to it. */
  readonly root: string;
  readonly runId: string;
  /** From the framework's adapter (`@qe/runner`): never a shell line. */
  readonly command: RunCommand;
  /** Extra variables, checked by `checkRunEnv`. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The command line of a remote test run. In the target's folder it creates `.qe-runs/<runId>`, records the shell's
 * PID there, then replaces the shell with the test process (`exec env …`), which keeps that PID. sshd starts every
 * exec in a session of its own, so the PID is also the process group: `remoteCancelCommand` signals the whole group.
 * Only fixed text and quoted values: the root, the run id (a UUID), the variables and the adapter's argv.
 */
export function remoteRunCommand(run: RemoteRun): string {
  const root = remoteFolder(run.root);
  const folder = `.qe-runs/${checkRunId(run.runId)}`;
  const env = Object.entries({
    ...checkRunEnv(run.env),
    // As locally: no bytecode files left in the project, output as it happens.
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  }).map(([name, value]) => `${name}=${value}`);
  const cwd = run.command.cwd === '.' ? root : `${root}/${projectPath(run.command.cwd, 'command.cwd')}`;
  return [
    `cd -- ${shellQuote(cwd)}`,
    `mkdir -p -- ${shellQuote(folder)}`,
    `echo "$$" > ${shellQuote(`${folder}/pid`)}`,
    `exec env ${shellCommand([...env, run.command.file, ...run.command.args])}`,
  ].join(' && ');
}

/**
 * Signals a remote run's process group (its PID recorded by `remoteRunCommand`): INT first, so the framework writes
 * its results; KILL after the grace time. Does nothing when the run has ended (no PID file, or no such group).
 * `kill -SIG -PGID`, without `--`: dash (Debian's and Ubuntu's `sh`) refuses `kill -SIG -- -PGID` and signals
 * nothing; the PID is checked to be digits only, so `-PGID` cannot be taken for an option.
 */
export function remoteCancelCommand(root: string, runId: string, signal: 'INT' | 'KILL'): string {
  const pidFile = shellQuote(`${remoteFolder(root)}/.qe-runs/${checkRunId(runId)}/pid`);
  return `pid=$(cat -- ${pidFile} 2>/dev/null) && case "$pid" in ''|*[!0-9]*) exit 0;; esac && kill -${signal} "-$pid" 2>/dev/null; exit 0`;
}
