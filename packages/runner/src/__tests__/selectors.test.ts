import { describe, expect, it } from 'vitest';

import { checkRunEnv, checkRunId, checkSelector, markerExpression, nodeId, projectPath } from '../index.js';

const refused = (fn: () => unknown) => {
  expect(fn).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }) as Error);
};

describe('project paths', () => {
  it('keeps relative paths inside the project, normalized', () => {
    expect(projectPath('tests/test_a.py')).toBe('tests/test_a.py');
    expect(projectPath('./tests//unit/./test_b.py')).toBe('tests/unit/test_b.py');
  });

  it('refuses paths that leave the project or are not plain relative paths', () => {
    for (const path of [
      '',
      '.',
      './',
      '../secret.py',
      'tests/../../x.py',
      '/etc/passwd',
      'C:/Windows/x.py',
      'c:x.py',
      'tests\\test_a.py',
      'tests/test_a.py\u0000.txt',
      'tests/\ntest_a.py',
      '-p',
      '--rootdir=/',
      './-x.py',
      'a'.repeat(1025),
    ])
      refused(() => projectPath(path));
  });

  it('names the field and never echoes the value', () => {
    expect(() => projectPath('../../etc/passwd', 'selector.path')).toThrow(/^selector\.path: /);
    expect(() => projectPath('../../etc/passwd')).not.toThrow(/etc/);
  });
});

describe('test ids', () => {
  it('accepts pytest node ids, parametrized ones included', () => {
    expect(nodeId('tests/test_a.py::test_b')).toBe('tests/test_a.py::test_b');
    expect(nodeId('tests/test_a.py::TestC::test_d[1-x, y=2]')).toBe(
      'tests/test_a.py::TestC::test_d[1-x, y=2]',
    );
    expect(nodeId('./tests/test_a.py::test_b')).toBe('tests/test_a.py::test_b');
  });

  it('refuses shell syntax, control characters, options and escapes (07_SECURITY T11)', () => {
    for (const id of [
      'tests/test_a.py::test_b; rm -rf ~',
      'tests/test_a.py::$(id)',
      'tests/test_a.py::`id`',
      'tests/test_a.py::test_b\nrm -rf ~',
      'tests/test_a.py::test_b && id',
      'tests/test_a.py::test_b | id',
      "tests/test_a.py::test_b' x",
      'tests/test_a.py::test_b" x',
      'tests/test_a.py::test_b > /tmp/x',
      '--rootdir=/ ::x',
      '-p evil::x',
      '../x.py::test',
      '/etc/x.py::test',
      '',
      `tests/${'a'.repeat(1020)}.py::t`,
    ])
      refused(() => nodeId(id));
  });
});

describe('marker expressions', () => {
  it('passes any expression of plain text, trimmed, as one argument', () => {
    expect(markerExpression(' slow and not (db or network) ')).toBe('slow and not (db or network)');
    // Shell characters are harmless here: the expression is one argv element, read by pytest's own parser.
    expect(markerExpression('a; $(b) `c`')).toBe('a; $(b) `c`');
  });

  it('refuses empty, long, multi-line and option-like expressions', () => {
    for (const expr of ['', '   ', 'a'.repeat(257), 'slow\nnot', 'slow\u0000', '-p evil', '--help'])
      refused(() => markerExpression(expr));
  });
});

describe('selectors', () => {
  it('checks and normalizes each kind', () => {
    expect(checkSelector({ kind: 'all' })).toEqual({ kind: 'all' });
    expect(checkSelector({ kind: 'file', path: './tests/test_a.py' })).toEqual({
      kind: 'file',
      path: 'tests/test_a.py',
    });
    expect(checkSelector({ kind: 'node', id: 'tests/test_a.py::t' })).toEqual({
      kind: 'node',
      id: 'tests/test_a.py::t',
    });
    expect(checkSelector({ kind: 'marker', expr: ' slow ' })).toEqual({ kind: 'marker', expr: 'slow' });
    expect(() => checkSelector({ kind: 'file', path: '../x' })).toThrow(/^selector\.path: /);
  });
});

describe('run ids and environment', () => {
  it('takes a lowercase UUID as run id only', () => {
    expect(checkRunId('0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f')).toBe('0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f');
    for (const id of [
      '',
      '../x',
      '0192D2A4-7C1E-7D3A-9F4B-2C5E8A1B3D6F',
      '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f/..',
    ])
      refused(() => checkRunId(id));
  });

  it('accepts test settings and refuses variables that change how processes start', () => {
    expect(checkRunEnv(undefined)).toEqual({});
    expect(checkRunEnv({ BASE_URL: 'https://app.test', RETRIES: '2' })).toEqual({
      BASE_URL: 'https://app.test',
      RETRIES: '2',
    });
    for (const name of [
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ENV',
      'PATH',
      'HOME',
      'IFS',
      'PYTEST_ADDOPTS',
      'PYTEST_PLUGINS',
      'PYTHONPATH',
      'PYTHONSTARTUP',
      'lower',
      'A-B',
      '1A',
      '',
    ])
      refused(() => checkRunEnv({ [name]: 'x' }));
    refused(() => checkRunEnv({ OK: 'a\u0000b' }));
    refused(() => checkRunEnv({ OK: 'x'.repeat(4097) }));
    refused(() =>
      checkRunEnv(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${String(i)}`, '1']))),
    );
  });
});

describe('project paths with shell syntax', () => {
  it('refuses them, though they would only be one argv element', () => {
    for (const path of [
      'tests/x.py; rm -rf ~',
      'tests/$(id).py',
      'tests/`id`.py',
      'a|b.py',
      'a&&b',
      "a'b",
      'a"b',
      '~/x.py',
      'x*.py',
    ])
      refused(() => projectPath(path));
    expect(projectPath('tests/my tests/test_a-b_c.py')).toBe('tests/my tests/test_a-b_c.py');
  });
});
