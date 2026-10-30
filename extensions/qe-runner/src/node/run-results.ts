import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkRunId, JUnitReader, type RunResults } from '@qe/runner';

import type { RunArtifact, RunOutcome, RunRecord } from '../common/qe-runner-protocol';

/** Larger reports are not read (a 10,000-case report is a few MB); the run says why. */
export const MAX_REPORT_BYTES = 200 * 1024 * 1024;
/** Failed cases kept in `run.json` and on the control plane's record; the report has them all. */
export const MAX_RECORDED_FAILURES = 200;
const MAX_RECORD_BYTES = 1024 * 1024;

/** Size and sha256 of a file, read as a stream; undefined when it does not exist. */
export async function describeFile(path: string): Promise<{ sizeBytes: number; sha256: string } | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (info?.isFile() !== true) return undefined;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { sizeBytes: info.size, sha256: hash.digest('hex') };
}

/** The run's JUnit report, read in chunks; `problem` when it is missing, too large or malformed. */
export async function readReport(path: string): Promise<{ results?: RunResults; problem?: string }> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return { problem: 'the run wrote no JUnit report' };
  if (info.size > MAX_REPORT_BYTES)
    return { problem: 'the JUnit report is larger than 200 MB and was not read' };
  const reader = new JUnitReader();
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) reader.write(chunk as string);
  try {
    return { results: reader.end() };
  } catch {
    return { problem: 'the JUnit report is not well-formed XML' };
  }
}

/** The files a run may have written, in the order a page lists them. */
export async function runArtifacts(
  root: string,
  files: { readonly junit: string; readonly htmlReport?: string; readonly log: string },
): Promise<RunArtifact[]> {
  const candidates: [RunArtifact['kind'], string | undefined][] = [
    ['junit_xml', files.junit],
    ['html_report', files.htmlReport],
    ['log', files.log],
  ];
  const artifacts: RunArtifact[] = [];
  for (const [kind, path] of candidates) {
    if (path === undefined) continue;
    const described = await describeFile(join(root, path));
    if (described !== undefined) artifacts.push({ kind, path, ...described });
  }
  return artifacts;
}

/** The outcome as recorded: every count, but only the failed and errored cases, at most 200. */
export function recordedOutcome(outcome: RunOutcome): RunOutcome {
  if (outcome.results === undefined) return outcome;
  const failures = outcome.results.cases.filter((c) => c.status === 'failed' || c.status === 'error');
  return {
    ...outcome,
    results: {
      ...outcome.results,
      cases: failures.slice(0, MAX_RECORDED_FAILURES),
      truncated: outcome.results.truncated || failures.length > MAX_RECORDED_FAILURES,
    },
  };
}

export async function saveRecord(root: string, record: RunRecord): Promise<void> {
  await writeFile(join(root, record.outcome.folder, 'run.json'), JSON.stringify(record));
}

const isRecord = (value: unknown): value is RunRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const { run, outcome } = value as Partial<RunRecord>;
  return (
    typeof run?.runId === 'string' &&
    typeof run.startedAt === 'string' &&
    typeof outcome?.state === 'string' &&
    typeof outcome.folder === 'string' &&
    Array.isArray(outcome.artifacts)
  );
};

/** The latest finished runs under `.qe-runs`, newest first; folders without a readable `run.json` are skipped. */
export async function readHistory(root: string, limit: number): Promise<RunRecord[]> {
  const entries = await readdir(join(root, '.qe-runs'), { withFileTypes: true }).catch(() => []);
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      checkRunId(entry.name);
    } catch {
      continue;
    }
    const path = join(root, '.qe-runs', entry.name, 'run.json');
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || info.size > MAX_RECORD_BYTES) continue;
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (isRecord(value) && value.run.runId === entry.name) records.push(value);
    } catch {
      // Not ours, or half-written: not part of the history.
    }
  }
  return records.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt)).slice(0, limit);
}
