import { DomainError } from '@qe/domain';

import { checkRunId, markerExpression, projectPath } from './selectors.js';
import type { RunCommand, RunContext, RunnerAdapter, TestNode, TestSelector } from './types.js';

/** Test sources, and Surefire's default includes: Test*.java, *Test.java, *Tests.java, *TestCase.java, in any folder. */
const TEST_SOURCES = 'src/test/java';
const TEST_FILE = /^(?:Test\w*|\w*Test|\w*Tests|\w*TestCase)\.java$/;
/** A Java class name (`com.example.FooTest`), with an optional method (`#adds`), as `-Dtest` takes it. */
const JAVA_TEST = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:#[A-Za-z_$][\w$]*)?$/;
/** Maven is the project's wrapper or `mvn`, configured by the backend: a plain name or path, nothing else. */
const TOOL = /^(?:\.\/mvnw|mvn|\/[\w./-]{1,255})$/;

const invalid = (field: string, reason: string) => new DomainError('INVALID_REQUEST', `${field}: ${reason}`);

/** `src/test/java/com/example/FooTest.java` → `com.example.FooTest`. */
function classOf(path: string, field = 'selector.path'): string {
  const file = projectPath(path, field);
  if (!file.startsWith(`${TEST_SOURCES}/`) || !file.endsWith('.java')) {
    throw invalid(field, `a test class under ${TEST_SOURCES}`);
  }
  const name = file.slice(TEST_SOURCES.length + 1, -'.java'.length).replaceAll('/', '.');
  if (!JAVA_TEST.test(name) || name.includes('#')) throw invalid(field, 'not a Java class');
  return name;
}

function testArgs(selector: TestSelector): string[] {
  switch (selector.kind) {
    case 'all':
      return [];
    case 'file':
      return [`-Dtest=${classOf(selector.path)}`];
    case 'node':
      if (selector.id.length > 1024 || !JAVA_TEST.test(selector.id))
        throw invalid('selector.id', 'not a test class or method');
      return [`-Dtest=${selector.id}`];
    case 'marker':
      // JUnit 5 tags (JUnit 4 categories): one argument, read by Surefire.
      return [`-Dgroups=${markerExpression(selector.expr)}`];
  }
}

/**
 * Maven Surefire (PHASE_11 §11.1, P11.6): `mvn -B test` with the selection as `-Dtest` or `-Dgroups`. Maven cannot
 * list tests without compiling, so the tree is the test classes under `src/test/java` by Surefire's default naming.
 * Surefire writes one report per class to `target/surefire-reports`, which has no command-line setting: the readers
 * take the reports written during the run. Maven exits 1 for failing tests and for a build that failed alike — a
 * run without reports is an error (the runner's rule for every framework).
 */
export const mavenAdapter: RunnerAdapter = {
  framework: 'maven',

  discoverFiles: { folder: TEST_SOURCES, pattern: TEST_FILE },

  parseDiscovery(listing: string): TestNode[] {
    const nodes: TestNode[] = [];
    for (const line of listing.split(/\r?\n/)) {
      const path = line.trim();
      if (path === '' || !TEST_FILE.test(path.slice(path.lastIndexOf('/') + 1))) continue;
      try {
        const name = classOf(path);
        nodes.push({ id: name, label: name, kind: 'file', file: path, children: [] });
      } catch {
        // Not a test class Surefire would run.
      }
    }
    return nodes.sort((a, b) => a.label.localeCompare(b.label));
  },

  buildCommand(selector: TestSelector, context: RunContext): RunCommand {
    checkRunId(context.runId);
    const tool = context.tool ?? 'mvn';
    if (!TOOL.test(tool)) throw invalid('tool', 'not Maven');
    return {
      file: tool,
      args: [
        '-B',
        'test',
        // Whole stack traces (the failing line), no run without the selected tests failing the build.
        '-DtrimStackTrace=false',
        '-Dsurefire.failIfNoSpecifiedTests=false',
        ...testArgs(selector),
      ],
      cwd: '.',
    };
  },

  stateOf: (exitCode) => (exitCode === 0 ? 'PASSED' : 'FAILED'),

  resultFiles: ({ runId }) => ({
    folder: `.qe-runs/${checkRunId(runId)}`,
    reports: { folder: 'target/surefire-reports', pattern: /^TEST-[\w.$-]+\.xml$/ },
  }),
};
