import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkRunId, JUnitReader, mergeResults, type RunFiles, type RunResults } from '@qe/runner';

import type { RunArtifact, RunOutcome, RunRecord } from '../common/qe-runner-protocol';

/** Larger reports are not read (a 10,000-case report is a few MB); the run says why. */
export const MAX_REPORT_BYTES = 200 * 1024 * 1024;
/** Failed cases kept in `run.json` and on the control plane's record; the report has them all. */
export const MAX_RECORDED_FAILURES = 200;
const MAX_RECORD_BYTES = 1024 * 1024;
/** Report files kept with a run (the control plane records at most 20 files; one is the log). */
export const MAX_KEPT_REPORTS = 19;
/** Report files read for one run (a few thousand test classes). */
const MAX_READ_REPORTS = 5_000;

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

/**
 * A run's results, from wherever its framework writes them: its one JUnit report (pytest), or the reports Surefire
 * wrote during the run into its own folder (`target/surefire-reports`, which keeps reports of earlier builds — only
 * those modified since `sinceMs` count). Those are copied into the run's folder (at most 19) so they stay with it,
 * and parsed and merged. `reports` are the report files kept with the run, relative to the project folder.
 */
export async function readRunResults(
  root: string,
  files: RunFiles,
  sinceMs: number,
): Promise<{ results?: RunResults; problem?: string; reports: string[] }> {
  if (files.junit !== undefined) {
    const read = await readReport(join(root, files.junit));
    return { ...read, reports: [files.junit] };
  }
  if (files.reports === undefined) return { problem: 'the run wrote no JUnit report', reports: [] };
  const folder = join(root, files.reports.folder);
  const names = (await readdir(folder).catch(() => []))
    .filter((name) => files.reports?.pattern.test(name) === true)
    .sort()
    .slice(0, MAX_READ_REPORTS);
  const fresh: string[] = [];
  let bytes = 0;
  for (const name of names) {
    const info = await stat(join(folder, name)).catch(() => undefined);
    // A second of slack: some file systems keep whole-second modification times.
    if (info?.isFile() !== true || info.mtimeMs < sinceMs - 1_000) continue;
    bytes += info.size;
    if (bytes > MAX_REPORT_BYTES)
      return { problem: 'the reports are larger than 200 MB and were not read', reports: [] };
    fresh.push(name);
  }
  if (fresh.length === 0) return { problem: 'the run wrote no test reports', reports: [] };
  const read = await Promise.all(fresh.map((name) => readReport(join(folder, name))));
  const parsed = read.flatMap((r) => (r.results === undefined ? [] : [r.results]));
  const reports: string[] = [];
  for (const name of fresh.slice(0, MAX_KEPT_REPORTS)) {
    await copyFile(join(folder, name), join(root, files.folder, name));
    reports.push(`${files.folder}/${name}`);
  }
  const malformed = read.length - parsed.length;
  return {
    ...(parsed.length > 0 && { results: mergeResults(parsed) }),
    ...(malformed > 0 && { problem: `${String(malformed)} of the reports could not be read` }),
    reports,
  };
}

/** The files a run may have written, in the order a page lists them. */
export async function runArtifacts(
  root: string,
  files: { readonly reports: readonly string[]; readonly htmlReport?: string; readonly log: string },
): Promise<RunArtifact[]> {
  const candidates: [RunArtifact['kind'], string | undefined][] = [
    ...files.reports.map((path): [RunArtifact['kind'], string] => ['junit_xml', path]),
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
