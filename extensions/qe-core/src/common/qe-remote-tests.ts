import type { TestRunResultRequest, TestSelectorRecord } from '@qe/contracts';

/**
 * Test runs on remote systems, for the QE Tests panel (PHASE_11 §11.4–11.6). The qe-remote extension implements it —
 * managed targets through the control plane and broker, personal hosts through the embedded broker — and the
 * qe-runner extension uses it; neither imports the other (04 §1: extensions share only qe-core). Bound only where
 * remote systems exist; the panel then offers "Run on".
 */
export const QeRemoteTestRunner = Symbol('QeRemoteTestRunner');

export interface RemoteTestSystem {
  readonly id: string;
  readonly name: string;
  /** The host, or `user@host[:port]` for a personal one. */
  readonly description: string;
  readonly kind: 'managed' | 'personal';
}

export interface RemoteTestRequest {
  readonly framework: 'pytest' | 'maven';
  readonly selector: TestSelectorRecord;
}

/** What a remote run reports as it goes: its output, then once how it ended. */
export interface RemoteTestRunEvents {
  output(text: string): void;
  /** `result` as recorded, or undefined when it never ran (refused, could not connect); `problem` says why. */
  finished(result: TestRunResultRequest | undefined, problem?: string): void;
}

export interface RemoteTestRun {
  readonly runId: string;
  /** Stops the run on the system (it is then recorded CANCELLED). */
  cancel(): void;
}

export interface QeRemoteTestRunner {
  /** The systems this mode offers (the panel lists them; one may still refuse runs by its policy). */
  systems(): Promise<RemoteTestSystem[]>;
  /** Starts a run in the system's folder; rejects with an Error whose message the user can act on. */
  run(systemId: string, request: RemoteTestRequest, events: RemoteTestRunEvents): Promise<RemoteTestRun>;
  /** A file of the system's folder, to open a failure where it ran (`qe-ssh://…`). */
  fileUri(systemId: string, path: string): string;
}
