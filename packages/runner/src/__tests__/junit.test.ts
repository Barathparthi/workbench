import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { failureLocation, JUnitReader, parseJUnit } from '../index.js';

// Tests run from the repository root.
const fixture = (name: string) => readFileSync(join('packages/runner/src/__tests__/fixtures', name), 'utf8');

describe('JUnit reports', () => {
  it('reads a real pytest report: counts, cases, and the failing line from the traceback', () => {
    const results = parseJUnit(fixture('pytest-sample.xml'));
    expect(results.counts).toEqual({ total: 5, passed: 3, failed: 1, errors: 0, skipped: 1 });
    expect(results.truncated).toBe(false);
    expect(results.cases.map((c) => [c.id, c.status])).toEqual([
      ['tests.test_calculator::test_add', 'passed'],
      ['tests.test_calculator::test_divide', 'passed'],
      ['tests.test_calculator::test_divide_by_zero', 'passed'],
      ['tests.test_calculator::test_add_negative_fails_on_purpose', 'failed'],
      ['tests.test_calculator::test_needs_network', 'skipped'],
    ]);
    const failed = results.cases[3];
    expect(failed).toMatchObject({
      name: 'test_add_negative_fails_on_purpose',
      className: 'tests.test_calculator',
      file: 'tests/test_calculator.py',
      line: 21,
      message: 'assert -5 == -6\n +  where -5 = add(-2, -3)',
    });
    expect(failed?.stack).toContain('>       assert add(-2, -3) == -6');
    expect(results.cases[4]).toMatchObject({
      message: 'needs the lab network',
      file: '/home/qe/project/tests/test_calculator.py',
      line: 24,
    });
    // Passed cases carry no texts or locations.
    expect(results.cases[0]).toEqual({
      id: 'tests.test_calculator::test_add',
      name: 'test_add',
      className: 'tests.test_calculator',
      status: 'passed',
      durationMs: 1,
    });
  });

  it('reads a Surefire report: errors apart from failures, the test’s own frame, no system output', () => {
    const results = parseJUnit(fixture('surefire-sample.xml'));
    expect(results.counts).toEqual({ total: 4, passed: 1, failed: 1, errors: 1, skipped: 1 });
    expect(results.durationMs).toBe(17);
    const [, failed, error, skipped] = results.cases;
    expect(failed).toMatchObject({
      id: 'com.example.CalculatorTest::addsNegativeFailsOnPurpose',
      status: 'failed',
      message: 'expected: <-6> but was: <-5>',
      file: 'CalculatorTest.java',
      line: 21,
    });
    expect(failed?.stack).not.toContain('a lot of log output');
    expect(error).toMatchObject({
      status: 'error',
      message: '/ by zero',
      file: 'CalculatorTest.java',
      line: 27,
    });
    expect(skipped).toEqual({
      id: 'com.example.CalculatorTest::needsNetwork',
      name: 'needsNetwork',
      className: 'com.example.CalculatorTest',
      status: 'skipped',
      durationMs: 0,
      message: 'needs the lab network',
    });
  });

  it('takes the strongest outcome when a case has several, and reads nested suites', () => {
    const results = parseJUnit(
      '<testsuites><testsuite><testsuite name="inner">' +
        '<testcase name="a"><skipped/><failure message="f">x.py:3: E</failure></testcase>' +
        '<testcase name="b"><error message="e"/><failure message="later"/></testcase>' +
        '<testcase name="c" time="nope"/>' +
        '</testsuite></testsuite></testsuites>',
    );
    expect(results.cases.map((c) => [c.id, c.status, c.message])).toEqual([
      ['a', 'failed', 'f'],
      ['b', 'error', 'e'],
      ['c', 'passed', undefined],
    ]);
    expect(results.cases[0]).toMatchObject({ file: 'x.py', line: 3 });
  });

  it('refuses malformed XML, and never expands entities a report declares', () => {
    for (const xml of [
      '',
      '<testsuite><testcase name="a"></testsuite>',
      '<testsuite>&undefined;</testsuite>',
      'not xml at all',
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><testsuite><testcase name="&lol2;"/></testsuite>',
    ])
      expect(() => parseJUnit(xml)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }) as Error);
  });

  it('refuses elements nested deeper than the limit', () => {
    const deep = '<a>'.repeat(70) + '</a>'.repeat(70);
    expect(() => parseJUnit(deep)).toThrow(/not well-formed/);
    expect(parseJUnit('<a>'.repeat(10) + '</a>'.repeat(10), { maxDepth: 10 }).counts.total).toBe(0);
  });

  it('caps what it keeps: cases, messages and stacks, saying so', () => {
    const many = `<testsuite>${'<testcase name="t"/>'.repeat(30)}</testsuite>`;
    const capped = parseJUnit(many, { maxCases: 10 });
    expect(capped.counts.total).toBe(30);
    expect(capped.cases).toHaveLength(10);
    expect(capped.truncated).toBe(true);
    const long = parseJUnit(
      `<testsuite><testcase name="${'n'.repeat(50)}"><failure message="${'m'.repeat(50)}">${'s'.repeat(60)}<![CDATA[more]]></failure></testcase></testsuite>`,
      { maxTextChars: 20 },
    );
    expect(long.cases[0]).toMatchObject({
      name: 'n'.repeat(20),
      message: 'm'.repeat(20),
      stack: 's'.repeat(20),
    });
    expect(long.truncated).toBe(true);
  });

  it('reads a 50 MB report in chunks, keeping memory to the capped cases', () => {
    const reader = new JUnitReader();
    const failure = `<failure message="boom">${'x'.repeat(1000)}\ntests/test_big.py:7: AssertionError</failure>`;
    reader.write('<?xml version="1.0"?><testsuites><testsuite name="big">');
    let written = 0;
    let n = 0;
    while (written < 50 * 1024 * 1024) {
      const chunk = Array.from({ length: 1000 }, () => {
        n++;
        return `<testcase classname="tests.test_big" name="test_${String(n)}" time="0.001">${n % 2 === 0 ? failure : ''}</testcase>`;
      }).join('');
      reader.write(chunk);
      written += chunk.length;
    }
    reader.write('</testsuite></testsuites>');
    const results = reader.end();
    expect(results.counts.total).toBe(n);
    expect(results.counts.failed).toBe(n / 2);
    expect(results.cases).toHaveLength(10_000);
    expect(results.truncated).toBe(true);
    expect(results.cases[1]).toMatchObject({ file: 'tests/test_big.py', line: 7 });
  });

  it('finds the failing line in pytest and JVM output', () => {
    expect(failureLocation('a.py:1: E\nlib/x.py:9: in f\ntests/t.py:3: AssertionError')).toEqual({
      file: 'tests/t.py',
      line: 3,
    });
    const jvm = 'at org.lib.Assert.fail(Assert.java:5)\n\tat com.x.FooTest.testA(FooTest.java:42)';
    expect(failureLocation(jvm, 'com.x.FooTest')).toEqual({ file: 'FooTest.java', line: 42 });
    expect(failureLocation(jvm)).toEqual({ file: 'Assert.java', line: 5 });
    expect(failureLocation('no location here')).toBeUndefined();
  });
});
