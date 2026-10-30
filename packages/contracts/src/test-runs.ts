import { z } from 'zod';

/**
 * QE runner records (05_API_CONTRACTS §2.5, PHASE_11 §11.5). The IDE backend runs the tests (in the workspace
 * runtime, or through the broker on a target); the control plane keeps the record: who ran what, the outcome, the
 * counts, the failures (capped) and where the run's files are. Artifacts stay where the run wrote them — the
 * workspace's `.qe-runs/<runId>/`; object storage and signed downloads wait on an org decision (D18).
 */

export const TestFrameworkName = z.enum(['pytest']);
export const TestRunState = z.enum(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'CANCELLED']);
export const FinishedRunState = z.enum(['PASSED', 'FAILED', 'ERROR', 'CANCELLED']);

/** The selector as recorded; the runner checks it (path confinement, no options) before anything runs. */
export const TestSelectorRecord = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1).max(1024) }),
  z.strictObject({ kind: z.literal('node'), id: z.string().min(1).max(1024) }),
  z.strictObject({ kind: z.literal('marker'), expr: z.string().min(1).max(256) }),
]);

export const TestRunCounts = z.strictObject({
  total: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  errors: z.number().int().min(0),
  skipped: z.number().int().min(0),
});

export const TEST_RUN_LIMITS = {
  /** Failed and errored cases kept on the record (the full list is in the run's JUnit file). */
  maxFailures: 200,
  maxFailureMessage: 4096,
  maxArtifacts: 20,
} as const;

export const TestFailureRecord = z.strictObject({
  id: z.string().max(1024),
  name: z.string().max(1024),
  status: z.enum(['failed', 'error']),
  file: z.string().max(1024).optional(),
  line: z.number().int().min(1).optional(),
  message: z.string().max(TEST_RUN_LIMITS.maxFailureMessage).optional(),
});

export const TestArtifactKind = z.enum(['junit_xml', 'html_report', 'log', 'screenshot', 'other']);

/** A file the run wrote, by its path relative to the project folder (`.qe-runs/<runId>/…`). */
export const TestArtifactRecord = z.strictObject({
  kind: TestArtifactKind,
  path: z
    .string()
    .max(1024)
    .regex(/^\.qe-runs\/[0-9a-f-]{36}\/[\w.-]{1,255}$/, 'a file directly in the run folder'),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** `POST /api/v1/workspaces/{id}/test-runs`: a run the workspace runtime is starting. */
export const CreateTestRunRequest = z.strictObject({
  framework: TestFrameworkName,
  selector: TestSelectorRecord,
});

/** `POST /api/v1/test-runs/{id}/result`: how it ended. Once only, by the user who started it. */
export const TestRunResultRequest = z.strictObject({
  state: FinishedRunState,
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0),
  counts: TestRunCounts,
  failures: z.array(TestFailureRecord).max(TEST_RUN_LIMITS.maxFailures),
  /** More failures existed than are listed, or texts were cut. */
  truncated: z.boolean(),
  artifacts: z.array(TestArtifactRecord).max(TEST_RUN_LIMITS.maxArtifacts),
});

export const TestArtifact = TestArtifactRecord.extend({ id: z.uuid() });

export const TestRun = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  targetId: z.uuid().nullable(),
  userId: z.uuid(),
  framework: TestFrameworkName,
  selector: TestSelectorRecord,
  state: TestRunState,
  exitCode: z.number().int().nullable(),
  counts: TestRunCounts.nullable(),
  failures: z.array(TestFailureRecord),
  truncated: z.boolean(),
  artifacts: z.array(TestArtifact),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const TestRunList = z.strictObject({ items: z.array(TestRun) });
export const TestRunIdParams = z.strictObject({ id: z.uuid() });
export const ListTestRunsQuery = z.strictObject({
  workspaceId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateTestRunRequest = z.infer<typeof CreateTestRunRequest>;
export type TestRunResultRequest = z.infer<typeof TestRunResultRequest>;
export type TestRun = z.infer<typeof TestRun>;
export type TestSelectorRecord = z.infer<typeof TestSelectorRecord>;
export type TestFailureRecord = z.infer<typeof TestFailureRecord>;
export type TestArtifactRecord = z.infer<typeof TestArtifactRecord>;
