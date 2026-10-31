import type { FsOp } from '@qe/contracts';
import type { RemoteTestRequest } from '@qe/theia-qe-core/lib/common/qe-remote-tests';
import type { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

import type { EmbeddedResult } from './embedded-broker-protocol';

/**
 * Managed targets in the desktop app (PHASE_10 §10.4): the renderer runs from `file://` and holds no credentials, so
 * the Electron backend talks to the control plane and the hosted broker for it — REST with the signed-in user's
 * bearer token, the terminal WebSocket without an Origin (its ticket is bound to the desktop marker). The frontend
 * sees the same stream protocol as the embedded broker's: `qews.v1` frames under stream ids it chose.
 */
export const MANAGED_RELAY_PATH = '/services/qe-managed-relay';

/** The code a relay call fails with when nobody is signed in (or the sign-in ended). */
export const SIGN_IN_REQUIRED = 'SIGN_IN_REQUIRED';

/** A managed target as the picker shows it. */
export interface ManagedTargetSummary {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly detail: string;
}

export interface ManagedRelayService extends RpcServer<StreamClient> {
  listTargets(): Promise<EmbeddedResult<ManagedTargetSummary[]>>;
  openTerminal(
    streamId: string,
    targetId: string,
    size: { cols: number; rows: number },
  ): Promise<EmbeddedResult<string>>;
  send(streamId: string, frame: string | Uint8Array): Promise<void>;
  closeTerminal(streamId: string): Promise<void>;
  fs(targetId: string, op: FsOp, request: unknown): Promise<EmbeddedResult<unknown>>;
  /** A test run on a managed target (no workspace: the desktop app's runs are its user's). */
  runTests(streamId: string, targetId: string, request: RemoteTestRequest): Promise<EmbeddedResult<string>>;
}

/** Terminal output and closes, from the backend to the frontend. */
export interface StreamClient {
  onFrame(streamId: string, frame: string | Uint8Array): void;
  onClosed(streamId: string, code: number, reason: string): void;
}
