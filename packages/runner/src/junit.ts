import { DomainError } from '@qe/domain';
import { SaxesParser, type SaxesTagPlain } from 'saxes';

import type { CaseStatus, RunCounts, RunResults, TestCaseResult } from './types.js';

export interface JUnitLimits {
  /** Cases kept with their details; the counts include every case. */
  readonly maxCases: number;
  /** Per case, for the message and for the stack (PHASE_11 §11.5: e.g. 64 KB). */
  readonly maxTextChars: number;
  /** Element nesting; real reports nest a few levels. */
  readonly maxDepth: number;
}

export const DEFAULT_JUNIT_LIMITS: JUnitLimits = { maxCases: 10_000, maxTextChars: 64 * 1024, maxDepth: 64 };

/** How a case ended, from the element inside `<testcase>`; the strongest one wins. */
const OUTCOMES: Readonly<Record<string, { status: CaseStatus; rank: number }>> = {
  error: { status: 'error', rank: 3 },
  failure: { status: 'failed', rank: 2 },
  skipped: { status: 'skipped', rank: 1 },
};

/**
 * Where a failure happened, from its text: pytest's `tests/test_a.py:21: AssertionError` (the last such line is the
 * test's own frame), or a JVM frame `at com.x.FooTest.testA(FooTest.java:42)` — the test class's own frame when there
 * is one (the first frames are usually the assertion library's), else the first.
 */
export function failureLocation(
  text: string,
  className?: string,
): { file: string; line: number } | undefined {
  let found: { file: string; line: number } | undefined;
  for (const match of text.matchAll(/^([\w./-]+\.py):(\d+):/gm))
    found = { file: match[1] ?? '', line: Number(match[2]) };
  if (found !== undefined) return found;
  let first: { file: string; line: number } | undefined;
  for (const match of text.matchAll(/at ([\w$.]+)\.[\w$<>]+\(([\w$]+\.(?:java|kt|groovy|scala)):(\d+)\)/g)) {
    const frame = { file: match[2] ?? '', line: Number(match[3]) };
    if (className !== undefined && match[1] === className) return frame;
    first ??= frame;
  }
  return first;
}

interface OpenCase {
  name: string;
  className: string | undefined;
  durationMs: number;
  status: CaseStatus;
  rank: number;
  message: string | undefined;
  stack: string;
  /** The element whose text is the stack (failure, error or skipped); other text — system-out — is ignored. */
  inOutcome: boolean;
}

/**
 * A streaming JUnit XML reader (PHASE_11 §11.5) for pytest's and Maven Surefire's reports: feed it the file in chunks
 * (`write`), then `end()`. Reports can be large — every case is counted, but at most `maxCases` are kept, with their
 * texts capped; `truncated` says so. saxes reads no DTD, so entities a report declares are never expanded (a
 * "billion laughs" file is just malformed). Malformed XML is `INVALID_REQUEST`.
 */
export class JUnitReader {
  protected readonly parser = new SaxesParser();
  protected readonly limits: JUnitLimits;
  protected readonly cases: TestCaseResult[] = [];
  protected counts = { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 };
  protected durationMs = 0;
  protected truncated = false;
  protected depth = 0;
  protected open: OpenCase | undefined;
  protected failure: Error | undefined;

  constructor(limits: Partial<JUnitLimits> = {}) {
    this.limits = { ...DEFAULT_JUNIT_LIMITS, ...limits };
    this.parser.on('error', (error) => {
      this.failure ??= error;
    });
    this.parser.on('opentag', (tag) => {
      this.openTag(tag);
    });
    this.parser.on('closetag', (tag) => {
      this.closeTag(tag.name);
    });
    this.parser.on('text', (text) => {
      this.addText(text);
    });
    this.parser.on('cdata', (text) => {
      this.addText(text);
    });
  }

  write(chunk: string): void {
    if (this.failure !== undefined) return;
    try {
      this.parser.write(chunk);
    } catch (error) {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  end(): RunResults {
    if (this.failure === undefined) {
      try {
        this.parser.close();
      } catch (error) {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (this.failure !== undefined) {
      throw new DomainError('INVALID_REQUEST', 'the JUnit report is not well-formed XML', {
        cause: this.failure,
      });
    }
    const counts: RunCounts = { ...this.counts };
    return { counts, durationMs: Math.round(this.durationMs), cases: this.cases, truncated: this.truncated };
  }

  protected openTag(tag: SaxesTagPlain): void {
    this.depth++;
    if (this.depth > this.limits.maxDepth) {
      this.failure ??= new Error(`elements nested deeper than ${String(this.limits.maxDepth)}`);
      return;
    }
    const attr = (name: string) => {
      const value = tag.attributes[name];
      return typeof value === 'string' ? value : undefined;
    };
    if (tag.name === 'testcase') {
      const seconds = Number(attr('time'));
      this.open = {
        name: this.cap(attr('name') ?? ''),
        className: attr('classname') === undefined ? undefined : this.cap(attr('classname') ?? ''),
        durationMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
        status: 'passed',
        rank: 0,
        message: undefined,
        stack: '',
        inOutcome: false,
      };
      return;
    }
    const outcome = OUTCOMES[tag.name];
    if (outcome !== undefined && this.open !== undefined) {
      if (outcome.rank > this.open.rank) {
        this.open.status = outcome.status;
        this.open.rank = outcome.rank;
        const message = attr('message');
        this.open.message = message === undefined ? undefined : this.cap(message);
        this.open.stack = '';
        this.open.inOutcome = true;
      }
    }
  }

  protected closeTag(name: string): void {
    this.depth--;
    if (this.open === undefined) return;
    if (OUTCOMES[name] !== undefined) {
      this.open.inOutcome = false;
      return;
    }
    if (name !== 'testcase') return;
    const c = this.open;
    this.open = undefined;
    this.counts.total++;
    if (c.status === 'passed') this.counts.passed++;
    else if (c.status === 'failed') this.counts.failed++;
    else if (c.status === 'error') this.counts.errors++;
    else this.counts.skipped++;
    this.durationMs += c.durationMs;
    if (this.cases.length >= this.limits.maxCases) {
      this.truncated = true;
      return;
    }
    const stack = c.stack.trim();
    const location = c.status === 'passed' ? undefined : failureLocation(stack, c.className);
    this.cases.push({
      id: c.className === undefined || c.className === '' ? c.name : `${c.className}::${c.name}`,
      name: c.name,
      ...(c.className !== undefined && c.className !== '' && { className: c.className }),
      ...(location !== undefined && { file: location.file, line: location.line }),
      status: c.status,
      durationMs: Math.round(c.durationMs),
      ...(c.message !== undefined && { message: c.message }),
      ...(stack !== '' && { stack }),
    });
  }

  protected addText(text: string): void {
    const c = this.open;
    if (c?.inOutcome !== true) return;
    const room = this.limits.maxTextChars - c.stack.length;
    if (room <= 0) {
      if (text.length > 0) this.truncated = true;
      return;
    }
    if (text.length > room) this.truncated = true;
    c.stack += text.slice(0, room);
  }

  protected cap(text: string): string {
    if (text.length <= this.limits.maxTextChars) return text;
    this.truncated = true;
    return text.slice(0, this.limits.maxTextChars);
  }
}

/** A whole report at once (small files and tests); large files go through `JUnitReader` chunk by chunk. */
export function parseJUnit(xml: string, limits?: Partial<JUnitLimits>): RunResults {
  const reader = new JUnitReader(limits);
  reader.write(xml);
  return reader.end();
}

/**
 * Several reports as one result (Surefire writes one per test class): counts and durations added up, cases kept in
 * report order up to `maxCases`, truncated when any report was or cases were left out.
 */
export function mergeResults(
  results: readonly RunResults[],
  maxCases = DEFAULT_JUNIT_LIMITS.maxCases,
): RunResults {
  const counts = { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 };
  const cases: TestCaseResult[] = [];
  let durationMs = 0;
  let truncated = false;
  for (const r of results) {
    counts.total += r.counts.total;
    counts.passed += r.counts.passed;
    counts.failed += r.counts.failed;
    counts.errors += r.counts.errors;
    counts.skipped += r.counts.skipped;
    durationMs += r.durationMs;
    truncated ||= r.truncated;
    for (const c of r.cases) {
      if (cases.length < maxCases) cases.push(c);
      else truncated = true;
    }
  }
  return { counts, durationMs, cases, truncated };
}
