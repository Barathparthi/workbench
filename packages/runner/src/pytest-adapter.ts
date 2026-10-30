import { DomainError } from '@qe/domain';

import { checkRunId, checkSelector, NODE_ID_PATTERN, projectPath } from './selectors.js';
import type { RunCommand, RunContext, RunnerAdapter, TestNode, TestSelector } from './types.js';

/** An interpreter is configured by the backend, not chosen by the user: a plain name or path, nothing else. */
const INTERPRETER = /^[\w./:\\-]{1,260}$/;

function interpreter(python: string): string {
  if (!INTERPRETER.test(python) || python.startsWith('-')) {
    throw new DomainError('INVALID_REQUEST', 'python: not an interpreter name or path');
  }
  return python;
}

const runDir = (runId: string) => `.qe-runs/${checkRunId(runId)}`;

function selectorArgs(selector: TestSelector): string[] {
  switch (selector.kind) {
    case 'all':
      return [];
    case 'file':
      return [selector.path];
    case 'node':
      return [selector.id];
    case 'marker':
      return ['-m', selector.expr];
  }
}

/** A collected node id, or undefined for pytest's other output lines (headers, warnings, the summary). */
function collectedId(line: string): { file: string; id: string } | undefined {
  const id = line.trim();
  if (!id.includes('::') || !NODE_ID_PATTERN.test(id)) return undefined;
  const file = id.slice(0, id.indexOf('::'));
  try {
    return { file: projectPath(file), id };
  } catch {
    return undefined;
  }
}

/**
 * pytest (PHASE_11 §11.2): `python -m pytest <selector> -o junit_family=xunit2 --junitxml=<out>/junit.xml
 * -p no:cacheprovider`, plus a self-contained HTML report when pytest-html is installed. The cache plugin is off so a
 * run leaves nothing but `.qe-runs/<runId>` behind.
 */
export const pytestAdapter: RunnerAdapter = {
  framework: 'pytest',

  discoverCommand: ({ python }): RunCommand => ({
    file: interpreter(python),
    args: ['-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider'],
    cwd: '.',
  }),

  parseDiscovery(stdout: string): TestNode[] {
    const files = new Map<string, TestNode[]>();
    for (const line of stdout.split(/\r?\n/)) {
      const collected = collectedId(line);
      if (collected === undefined) continue;
      const tests = files.get(collected.file) ?? [];
      tests.push({
        id: collected.id,
        label: collected.id.slice(collected.id.indexOf('::') + 2),
        kind: 'test',
        file: collected.file,
        children: [],
      });
      files.set(collected.file, tests);
    }
    return [...files.entries()].map(([file, children]) => ({
      id: file,
      label: file,
      kind: 'file',
      file,
      children,
    }));
  },

  buildCommand(selector: TestSelector, context: RunContext): RunCommand {
    const out = runDir(context.runId);
    return {
      file: interpreter(context.python),
      args: [
        '-m',
        'pytest',
        '-o',
        'junit_family=xunit2',
        `--junitxml=${out}/junit.xml`,
        '-p',
        'no:cacheprovider',
        ...(context.htmlReport ? [`--html=${out}/report.html`, '--self-contained-html'] : []),
        ...selectorArgs(checkSelector(selector)),
      ],
      cwd: '.',
    };
  },

  resultFiles: ({ runId }) => ({
    junit: `${runDir(runId)}/junit.xml`,
    htmlReport: `${runDir(runId)}/report.html`,
  }),
};
