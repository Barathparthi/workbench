import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { remoteCancelCommand, remoteRunCommand, shellCommand, shellQuote } from '../index.js';

const RUN = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const posix = process.platform !== 'win32';

/** What an attacker would put in an argument, a path or a variable (07_SECURITY T11). */
const HOSTILE = [
  'plain',
  '',
  ' ',
  'two words',
  "it's",
  "'",
  "''",
  '"',
  '"$HOME"',
  '$HOME',
  '${HOME}',
  '$(touch pwned)',
  '`touch pwned`',
  '; touch pwned',
  '&& touch pwned',
  '| touch pwned',
  '> pwned',
  '< /etc/passwd',
  'line\nbreak; touch pwned',
  'tab\there',
  '\\',
  "\\'",
  '*',
  '~',
  '-rf',
  '--help',
  '!',
  '#comment',
  'ünïcødé ✓',
  "'; touch pwned; echo '",
];

const dir = mkdtempSync(join(tmpdir(), 'qe-exec-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs a command line with the system's POSIX shell, in `cwd`. */
const sh = (line: string, cwd: string) => spawnSync('sh', ['-c', line], { cwd, encoding: 'utf8' });

describe('shell quoting (CLAUDE.md rule 6)', () => {
  it("puts every argument in single quotes, a quote inside as '\\''", () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
    expect(shellCommand(['python3', '-m', 'pytest', 'a b'])).toBe("'python3' '-m' 'pytest' 'a b'");
  });

  it('refuses NUL and an empty command', () => {
    expect(() => shellQuote('a\0b')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }) as Error);
    expect(() => shellCommand([])).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }) as Error);
  });

  it.runIf(posix)('delivers every hostile argument to the program unchanged, and runs nothing else', () => {
    const cwd = join(dir, 'roundtrip');
    mkdirSync(cwd);
    const result = sh(`printf '%s\\0' ${shellCommand(HOSTILE)}`, cwd);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\0').slice(0, -1)).toEqual(HOSTILE);
    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe('remote run command', () => {
  const command = { file: 'python3', args: ['-m', 'pytest', '-m', 'slow and not db'], cwd: '.' };

  it('is built from fixed text and quoted values only', () => {
    expect(remoteRunCommand({ root: '/home/qe', runId: RUN, command, env: { BASE_URL: 'http://x' } })).toBe(
      `cd -- '/home/qe' && mkdir -p -- '.qe-runs/${RUN}' && echo "$$" > '.qe-runs/${RUN}/pid' && ` +
        "exec env 'BASE_URL=http://x' 'PYTHONDONTWRITEBYTECODE=1' 'PYTHONUNBUFFERED=1' 'python3' '-m' 'pytest' '-m' 'slow and not db'",
    );
    expect(remoteCancelCommand('/home/qe', RUN, 'INT')).toBe(
      `pid=$(cat -- '/home/qe/.qe-runs/${RUN}/pid' 2>/dev/null) && case "$pid" in ''|*[!0-9]*) exit 0;; esac && ` +
        'kill -INT "-$pid" 2>/dev/null; exit 0',
    );
  });

  it('refuses a relative root, a bad run id, a variable that changes how processes start, and a working folder that leaves the root', () => {
    const refused = (fn: () => unknown) => {
      expect(fn).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }) as Error);
    };
    refused(() => remoteRunCommand({ root: 'home/qe', runId: RUN, command }));
    refused(() => remoteRunCommand({ root: '/home/qe\0', runId: RUN, command }));
    refused(() => remoteRunCommand({ root: '/home/qe', runId: '../../etc', command }));
    refused(() => remoteRunCommand({ root: '/home/qe', runId: RUN, command, env: { LD_PRELOAD: '/x.so' } }));
    refused(() => remoteRunCommand({ root: '/home/qe', runId: RUN, command: { ...command, cwd: '../..' } }));
    refused(() => remoteRunCommand({ root: '/home/qe', runId: RUN, command: { ...command, args: ['a\0'] } }));
    refused(() => remoteCancelCommand('/home/qe', 'x; touch pwned', 'INT'));
  });

  it.runIf(posix)(
    'runs in a folder whose name is itself an injection attempt, passing hostile values unchanged',
    () => {
      const root = join(dir, "qe dir'; touch pwned; '$(touch pwned)");
      mkdirSync(root);
      const line = remoteRunCommand({
        root,
        runId: RUN,
        command: {
          file: 'sh',
          args: ['-c', 'printf "%s\\0" "$@" > args.bin; printf "%s" "$EXTRA" > env.bin', 'sh', ...HOSTILE],
          cwd: '.',
        },
        env: { EXTRA: "'; touch pwned; '$(touch pwned)" },
      });
      const result = sh(line, dir);
      expect(result.status).toBe(0);
      expect(readFileSync(join(root, 'args.bin'), 'utf8').split('\0').slice(0, -1)).toEqual(HOSTILE);
      expect(readFileSync(join(root, 'env.bin'), 'utf8')).toBe("'; touch pwned; '$(touch pwned)");
      expect(readFileSync(join(root, '.qe-runs', RUN, 'pid'), 'utf8').trim()).toMatch(/^\d+$/);
      expect(existsSync(join(dir, 'pwned'))).toBe(false);
      expect(existsSync(join(root, 'pwned'))).toBe(false);
    },
  );

  it.runIf(posix)('cancels the run’s whole process group, and does nothing once the run has gone', () => {
    const root = join(dir, 'cancel');
    mkdirSync(root);
    // A run that starts a child of its own and waits; the cancel must reach both.
    const line = remoteRunCommand({
      root,
      runId: RUN,
      command: { file: 'sh', args: ['-c', 'sleep 30 & echo $! > child.pid; wait'], cwd: '.' },
    });
    // setsid: a session and process group of its own, as sshd gives every exec.
    const run = spawnSync(
      'sh',
      ['-c', `setsid sh -c ${shellQuote(line)} & sleep 1; ${remoteCancelCommand(root, RUN, 'KILL')}; wait`],
      {
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(run.error).toBeUndefined();
    const child = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
    expect(() => process.kill(child, 0)).toThrow();
    // Nothing left to signal: a quiet success.
    expect(sh(remoteCancelCommand(root, RUN, 'INT'), dir).status).toBe(0);
    expect(sh(remoteCancelCommand(join(dir, 'missing'), RUN, 'INT'), dir).status).toBe(0);
  });
});
