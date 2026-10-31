import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { adapterFor, mavenAdapter, mergeResults, parseJUnit, type RunContext } from '../index.js';

const RUN = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const context: RunContext = { runId: RUN, python: 'python3', htmlReport: false };
const BASE = ['-B', 'test', '-DtrimStackTrace=false', '-Dsurefire.failIfNoSpecifiedTests=false'];
// Tests run from the repository root.
const SUREFIRE = readFileSync(join('packages/runner/src/__tests__/fixtures', 'surefire-sample.xml'), 'utf8');

describe('Maven Surefire adapter', () => {
  it('is the maven framework’s adapter', () => {
    expect(adapterFor('maven')).toBe(mavenAdapter);
  });

  it('builds mvn test with the selection as -Dtest or -Dgroups, the project’s wrapper when there is one', () => {
    const args = (selector: Parameters<typeof mavenAdapter.buildCommand>[0]) =>
      mavenAdapter.buildCommand(selector, context).args;
    expect(mavenAdapter.buildCommand({ kind: 'all' }, context)).toEqual({
      file: 'mvn',
      args: BASE,
      cwd: '.',
    });
    expect(args({ kind: 'file', path: './src/test/java/com/example/CalculatorTest.java' })).toEqual([
      ...BASE,
      '-Dtest=com.example.CalculatorTest',
    ]);
    expect(args({ kind: 'node', id: 'com.example.CalculatorTest#adds' })).toEqual([
      ...BASE,
      '-Dtest=com.example.CalculatorTest#adds',
    ]);
    expect(args({ kind: 'marker', expr: 'slow & !db' })).toEqual([...BASE, '-Dgroups=slow & !db']);
    expect(mavenAdapter.buildCommand({ kind: 'all' }, { ...context, tool: './mvnw' }).file).toBe('./mvnw');
  });

  it('refuses selections and tools that are not Maven’s (07_SECURITY T11)', () => {
    const refused = (fn: () => unknown) => {
      expect(fn).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }) as Error);
    };
    for (const path of [
      'src/main/java/com/example/Calculator.java',
      'src/test/java/../../pom.xml',
      'src/test/java/com/example/Calc Test.java',
      'src/test/java/com/example/FooTest.kt',
      'src/test/java/$(id)Test.java',
    ])
      refused(() => mavenAdapter.buildCommand({ kind: 'file', path }, context));
    for (const id of [
      'com.example.FooTest; id',
      '-Dmaven.repo.local=/tmp',
      'Foo#bar#baz',
      'a b',
      'a'.repeat(1025),
    ])
      refused(() => mavenAdapter.buildCommand({ kind: 'node', id }, context));
    refused(() => mavenAdapter.buildCommand({ kind: 'marker', expr: '-Dx=y' }, context));
    for (const tool of ['mvn; id', 'mvn.cmd', 'C:\\maven\\bin\\mvn.cmd', '../mvnw', '-v'])
      refused(() => mavenAdapter.buildCommand({ kind: 'all' }, { ...context, tool }));
    refused(() => mavenAdapter.buildCommand({ kind: 'all' }, { ...context, runId: '../x' }));
  });

  it('lists test classes by Surefire’s default naming, from the files under src/test/java', () => {
    expect(mavenAdapter.discoverFiles).toEqual({
      folder: 'src/test/java',
      pattern: expect.any(RegExp) as unknown,
    });
    const listing = [
      'src/test/java/com/example/CalculatorTest.java',
      'src/test/java/com/example/TestHelpers.java',
      'src/test/java/com/example/ParserTests.java',
      'src/test/java/com/example/LegacyTestCase.java',
      'src/test/java/com/example/Fixtures.java',
      'src/test/java/com/example/package-info.java',
      'src/main/java/com/example/MainTest.java',
      '',
    ].join('\n');
    expect(mavenAdapter.parseDiscovery(listing).map((n) => [n.id, n.file])).toEqual([
      ['com.example.CalculatorTest', 'src/test/java/com/example/CalculatorTest.java'],
      ['com.example.LegacyTestCase', 'src/test/java/com/example/LegacyTestCase.java'],
      ['com.example.ParserTests', 'src/test/java/com/example/ParserTests.java'],
      ['com.example.TestHelpers', 'src/test/java/com/example/TestHelpers.java'],
    ]);
  });

  it('reads Surefire’s reports from target/surefire-reports; any failed exit is FAILED (the runner makes it ERROR without reports)', () => {
    expect(mavenAdapter.resultFiles({ runId: RUN })).toEqual({
      folder: `.qe-runs/${RUN}`,
      reports: { folder: 'target/surefire-reports', pattern: expect.any(RegExp) as unknown },
    });
    const pattern = mavenAdapter.resultFiles({ runId: RUN }).reports?.pattern ?? /$^/;
    expect(
      ['TEST-com.example.CalculatorTest.xml', 'com.example.CalculatorTest.txt', 'TEST-a b.xml'].map((n) =>
        pattern.test(n),
      ),
    ).toEqual([true, false, false]);
    expect([0, 1, 2].map((c) => mavenAdapter.stateOf(c))).toEqual(['PASSED', 'FAILED', 'FAILED']);
  });
});

describe('merging reports', () => {
  it('adds up counts and durations, keeps cases in order up to the cap', () => {
    const one = parseJUnit(SUREFIRE);
    const merged = mergeResults([one, one]);
    expect(merged.counts).toEqual({ total: 8, passed: 2, failed: 2, errors: 2, skipped: 2 });
    expect(merged.durationMs).toBe(one.durationMs * 2);
    expect(merged.cases).toHaveLength(8);
    expect(merged.truncated).toBe(false);
    const capped = mergeResults([one, one], 5);
    expect(capped.cases).toHaveLength(5);
    expect(capped.truncated).toBe(true);
    expect(mergeResults([])).toEqual({
      counts: { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 },
      durationMs: 0,
      cases: [],
      truncated: false,
    });
  });
});
