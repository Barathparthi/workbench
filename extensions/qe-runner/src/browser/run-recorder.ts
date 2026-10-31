import type { TestRun, TestRunResultRequest, TestSelectorRecord } from '@qe/contracts';
import type { ControlPlaneClient } from '@qe/client-sdk';

import type { RunOutcome } from '../common/qe-runner-protocol';

const MAX_FAILURES = 200;
const MAX_TEXT = 4096;
const NO_COUNTS = { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 };

/** A finished run as the control plane records it (05_API_CONTRACTS §2.5): capped failures, the run's files. */
export function resultOf(outcome: RunOutcome): TestRunResultRequest {
  const state = outcome.state === 'RUNNING' || outcome.state === 'QUEUED' ? 'ERROR' : outcome.state;
  const failed = (outcome.results?.cases ?? []).filter((c) => c.status === 'failed' || c.status === 'error');
  return {
    state,
    ...(outcome.exitCode !== undefined && { exitCode: outcome.exitCode }),
    durationMs: Math.max(0, Math.round(outcome.durationMs)),
    counts: outcome.results?.counts ?? NO_COUNTS,
    failures: failed.slice(0, MAX_FAILURES).map((c) => ({
      id: c.id.slice(0, 1024),
      name: c.name.slice(0, 1024),
      status: c.status === 'error' ? ('error' as const) : ('failed' as const),
      ...(c.file !== undefined && { file: c.file.slice(0, 1024) }),
      ...(c.line !== undefined && c.line >= 1 && { line: c.line }),
      ...((c.message ?? c.stack) !== undefined && {
        message: (c.message ?? c.stack ?? '').slice(0, MAX_TEXT),
      }),
    })),
    truncated: (outcome.results?.truncated ?? false) || failed.length > MAX_FAILURES,
    artifacts: outcome.artifacts.map((a) => ({
      kind: a.kind,
      path: a.path,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
    })),
  };
}

/**
 * Where the panel records runs in the project folder. Hosted: the control plane, first (its record's id names the
 * run's folder), then the result. Local web and desktop: nothing — the run's own `run.json` is the history.
 */
export interface RunRecorder {
  /** The record's id, or undefined when runs are not recorded here. */
  start(framework: 'pytest', selector: TestSelectorRecord): Promise<string | undefined>;
  finish(recordId: string, outcome: RunOutcome): Promise<void>;
}

export const noRecorder: RunRecorder = {
  start: () => Promise.resolve(undefined),
  finish: () => Promise.resolve(),
};

/** The hosted workspace's records, through the control plane (cookie and CSRF token as for every IDE call). */
export function hostedRecorder(
  client: Pick<ControlPlaneClient, 'request'>,
  workspaceId: string,
): RunRecorder {
  return {
    async start(framework, selector) {
      const run = (await client.request(
        'POST',
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/test-runs`,
        {
          framework,
          selector,
        },
      )) as TestRun;
      return run.id;
    },
    async finish(recordId, outcome) {
      await client.request(
        'POST',
        `/api/v1/test-runs/${encodeURIComponent(recordId)}/result`,
        resultOf(outcome),
      );
    },
  };
}
