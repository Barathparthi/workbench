import { describe, expect, it } from 'vitest';

import { adapterFor, Frameworks, pytestAdapter, type RunContext } from '../index.js';

const RUN = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const context: RunContext = { runId: RUN, python: 'python3', htmlReport: false };
const BASE = [
  '-m',
  'pytest',
  '-o',
  'junit_family=xunit2',
  `--junitxml=.qe-runs/${RUN}/junit.xml`,
  '-p',
  'no:cacheprovider',
];

describe('pytest adapter', () => {
  it('is the adapter of the only framework so far', () => {
    expect(Frameworks).toEqual(['pytest']);
    expect(adapterFor('pytest')).toBe(pytestAdapter);
  });

  it('builds argv for each selector, in the project folder, writing JUnit XML under .qe-runs/<runId>', () => {
    const args = (selector: Parameters<typeof pytestAdapter.buildCommand>[0]) =>
      pytestAdapter.buildCommand(selector, context);
    expect(args({ kind: 'all' })).toEqual({ file: 'python3', args: BASE, cwd: '.' });
    expect(args({ kind: 'file', path: './tests/test_a.py' }).args).toEqual([...BASE, 'tests/test_a.py']);
    expect(args({ kind: 'node', id: 'tests/test_a.py::test_b[1]' }).args).toEqual([
      ...BASE,
      'tests/test_a.py::test_b[1]',
    ]);
    // The expression stays one argument, whatever it contains.
    expect(args({ kind: 'marker', expr: 'slow and not db' }).args).toEqual([
      ...BASE,
      '-m',
      'slow and not db',
    ]);
  });

  it('adds a self-contained HTML report when pytest-html is there', () => {
    expect(pytestAdapter.buildCommand({ kind: 'all' }, { ...context, htmlReport: true }).args).toEqual([
      ...BASE,
      `--html=.qe-runs/${RUN}/report.html`,
      '--self-contained-html',
    ]);
    expect(pytestAdapter.resultFiles({ runId: RUN })).toEqual({
      junit: `.qe-runs/${RUN}/junit.xml`,
      htmlReport: `.qe-runs/${RUN}/report.html`,
    });
  });

  it('never builds a command from a hostile selector, run id or interpreter (07_SECURITY T11)', () => {
    const hostile = [
      { kind: 'file', path: 'tests/x.py; rm -rf ~' },
      { kind: 'file', path: '--rootdir=/' },
      { kind: 'file', path: '../outside.py' },
      { kind: 'node', id: 'tests/x.py::t$(id)' },
      { kind: 'node', id: 'tests/x.py::t`id`' },
      { kind: 'node', id: 'tests/x.py::t\n-p evil' },
      { kind: 'marker', expr: '-p evil' },
      { kind: 'marker', expr: 'a\nb' },
    ] as const;
    for (const selector of hostile)
      expect(() => pytestAdapter.buildCommand(selector, context)).toThrow(
        expect.objectContaining({ code: 'INVALID_REQUEST' }) as Error,
      );
    expect(() => pytestAdapter.buildCommand({ kind: 'all' }, { ...context, runId: '../../etc' })).toThrow(
      /runId/,
    );
    for (const python of ['python3; id', '-c', 'py thon', '$(id)', ''])
      expect(() => pytestAdapter.buildCommand({ kind: 'all' }, { ...context, python })).toThrow(/python/);
    expect(
      pytestAdapter.buildCommand({ kind: 'all' }, { ...context, python: 'C:\\Python312\\python.exe' }).file,
    ).toBe('C:\\Python312\\python.exe');
  });

  it('lists tests with the collect-only command and builds the tree from its output', () => {
    expect(pytestAdapter.discoverCommand({ python: 'python3' })).toEqual({
      file: 'python3',
      args: ['-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider'],
      cwd: '.',
    });
    const stdout = [
      'tests/test_math.py::test_add',
      'tests/test_math.py::TestDiv::test_by_zero[1-0]',
      'tests/unit/test_io.py::test_read',
      '',
      'warnings summary',
      '../outside.py::test_x',
      '-p::evil',
      '3 tests collected in 0.02s',
    ].join('\r\n');
    expect(pytestAdapter.parseDiscovery(stdout)).toEqual([
      {
        id: 'tests/test_math.py',
        label: 'tests/test_math.py',
        kind: 'file',
        file: 'tests/test_math.py',
        children: [
          {
            id: 'tests/test_math.py::test_add',
            label: 'test_add',
            kind: 'test',
            file: 'tests/test_math.py',
            children: [],
          },
          {
            id: 'tests/test_math.py::TestDiv::test_by_zero[1-0]',
            label: 'TestDiv::test_by_zero[1-0]',
            kind: 'test',
            file: 'tests/test_math.py',
            children: [],
          },
        ],
      },
      {
        id: 'tests/unit/test_io.py',
        label: 'tests/unit/test_io.py',
        kind: 'file',
        file: 'tests/unit/test_io.py',
        children: [
          {
            id: 'tests/unit/test_io.py::test_read',
            label: 'test_read',
            kind: 'test',
            file: 'tests/unit/test_io.py',
            children: [],
          },
        ],
      },
    ]);
    expect(pytestAdapter.parseDiscovery('no tests ran in 0.01s')).toEqual([]);
  });
});
