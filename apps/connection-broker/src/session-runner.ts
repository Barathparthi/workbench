import type { RedeemTicketResponse } from '@qe/contracts';
import {
  createHostKeyVerifier,
  DomainError,
  isDomainError,
  mapSshError,
  runRemoteTests,
  messageFor,
  type CredentialSource,
  type ErrorCode,
  type HostKeyVerifier,
  type SessionRegistry,
  type SshConnection,
  type SshTransport,
  type StreamSocket,
  TerminalBridge,
  type RemoteRunOutcome,
} from '@qe/broker-core';
import { checkTargetHost, type Resolver } from '@qe/policy';

import type { ControlPlaneClient } from './control-plane-client.js';

export interface RunnerDeps {
  readonly controlPlane: ControlPlaneClient;
  readonly transport: SshTransport;
  readonly credentials: CredentialSource;
  readonly resolver: Resolver;
  readonly deniedCidrs: readonly string[];
  readonly registry: SessionRegistry;
  readonly instanceId: string;
  readonly log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export const presented = (v: HostKeyVerifier) =>
  v.presented === undefined || v.outcome === undefined ? undefined : { outcome: v.outcome, ...v.presented };

/**
 * Phase 08 §8.3 steps 3–8, for every kind of session: every check runs again here even though the control plane
 * authorized the session — the port, the address against the policy (DNS may have changed), the credential — and the
 * host key is pinned before any credential is used. Fails with the API code the user and the audit trail see.
 */
export async function connectToTarget(
  snapshot: RedeemTicketResponse,
  deps: Pick<RunnerDeps, 'transport' | 'credentials' | 'resolver' | 'deniedCidrs'>,
  verifier: HostKeyVerifier,
): Promise<SshConnection> {
  const t = snapshot.target;
  if (t.jumpHostId !== null) throw new DomainError('TARGET_NOT_ALLOWED'); // jump hosts: Phase 19
  if (!snapshot.policy.allowedPorts.includes(t.port)) throw new DomainError('TARGET_NOT_ALLOWED');
  const address = await checkTargetHost(
    t.host,
    snapshot.policy.allowedCidrs,
    deps.deniedCidrs,
    deps.resolver,
  );
  if (!address.allowed) throw new DomainError('TARGET_ADDRESS_FORBIDDEN');
  if (snapshot.credential === null) throw new DomainError('CREDENTIALS_UNAVAILABLE');
  const credential = await deps.credentials.resolve(snapshot.credential, t.principal);
  try {
    return await deps.transport.connect(
      { address: address.address, port: t.port, username: t.principal },
      credential,
      verifier,
    );
  } catch (error) {
    throw new DomainError(mapSshError(error, verifier.outcome));
  }
}

/** The API code of a failure, for the user and the close reason. */
export const failureCode = (error: unknown): ErrorCode =>
  isDomainError(error) ? error.code : 'INTERNAL_ERROR';

/**
 * One accepted stream (Phase 08 §8.3 steps 3–10): every check runs again here even though the control plane
 * authorized the session — the address against the policy (DNS may have changed), the port, the host key — before
 * any credential is used. Results are reported to the control plane for state and audit.
 */
export function runTerminalSession(
  socket: StreamSocket,
  snapshot: RedeemTicketResponse,
  deps: RunnerDeps,
): TerminalBridge {
  const bridge = new TerminalBridge(socket, {
    idleMs: snapshot.policy.idleTimeoutSec * 1000,
    expiresAt: new Date(snapshot.expiresAt),
  });
  deps.registry.add({
    sessionId: snapshot.sessionId,
    userId: snapshot.user.id,
    targetId: snapshot.target.id,
    bridge,
  });
  bridge.sendControl({ t: 'status', state: 'CONNECTING' });

  const verifier = createHostKeyVerifier(snapshot.hostKeys);
  let opened = false;
  let failure: ErrorCode | undefined;
  bridge.onClosed((result) => {
    void deps.controlPlane
      .report(snapshot.sessionId, {
        state: opened ? 'CLOSED' : 'FAILED',
        reason: failure ?? result.reason,
        brokerInstance: deps.instanceId,
        hostKey: presented(verifier),
        bytesIn: result.bytesIn,
        bytesOut: result.bytesOut,
      })
      .catch((error: unknown) => {
        deps.log.warn({ err: error, sessionId: snapshot.sessionId }, 'could not report the session end');
      });
  });

  void (async () => {
    try {
      const connection = await connectToTarget(snapshot, deps, verifier);
      bridge.onClosed(() => {
        connection.close();
      });
      // The user may have closed the stream while we were connecting.
      if (bridge.isClosed) return;
      if (verifier.presented !== undefined) {
        bridge.sendControl({ t: 'hostkey', ...verifier.presented, verified: true });
      }
      // The size the IDE sent when it opened the session; later changes arrive as `resize` frames.
      const size = snapshot.terminal ?? { cols: 80, rows: 24 };
      const pty = await connection.shell({ ...size, term: 'xterm-256color' });
      opened = true;
      bridge.attach(pty);
      bridge.sendControl({ t: 'status', state: 'ACTIVE' });
      await deps.controlPlane.report(snapshot.sessionId, {
        state: 'ACTIVE',
        reason: 'opened',
        brokerInstance: deps.instanceId,
        hostKey: presented(verifier),
      });
    } catch (error) {
      failure = failureCode(error);
      deps.log.warn({ sessionId: snapshot.sessionId, code: failure }, 'remote session failed to open');
      bridge.sendControl({ t: 'error', code: failure, message: messageFor(failure) });
      bridge.close('connect_failed', failure);
    }
  })();
  return bridge;
}

/** How long a session's closing report waits for its run to be recorded (a target that never answers). */
const RUN_RECORD_WAIT_MS = 30_000;

/**
 * One accepted exec stream (PHASE_11 §11.4): the session's test run, on the target. The same checks as a terminal
 * run again first — and the broker itself refuses a session without a run, or under a policy without `exec`. The
 * command comes from the run's framework and selector (`runRemoteTests`), never from the client; the stream carries
 * its output, and the IDE's Cancel or any early end stops it on the target. The run's result is reported to the
 * control plane before the session's end, so the run is recorded with its counts rather than as cancelled blind.
 */
export function runExecSession(
  socket: StreamSocket,
  snapshot: RedeemTicketResponse,
  deps: RunnerDeps,
): TerminalBridge {
  const bridge = new TerminalBridge(socket, {
    idleMs: snapshot.policy.idleTimeoutSec * 1000,
    expiresAt: new Date(snapshot.expiresAt),
  });
  deps.registry.add({
    sessionId: snapshot.sessionId,
    userId: snapshot.user.id,
    targetId: snapshot.target.id,
    bridge,
  });
  bridge.sendControl({ t: 'status', state: 'CONNECTING' });

  const verifier = createHostKeyVerifier(snapshot.hostKeys);
  let opened = false;
  let failure: ErrorCode | undefined;
  let run: Promise<RemoteRunOutcome | undefined> = Promise.resolve(undefined);
  const recorded = () =>
    Promise.race([run.catch(() => undefined), new Promise((done) => setTimeout(done, RUN_RECORD_WAIT_MS))]);
  bridge.onClosed((result) => {
    void recorded()
      .then(() =>
        deps.controlPlane.report(snapshot.sessionId, {
          state: opened ? 'CLOSED' : 'FAILED',
          reason: failure ?? result.reason,
          brokerInstance: deps.instanceId,
          hostKey: presented(verifier),
          bytesIn: result.bytesIn,
          bytesOut: result.bytesOut,
        }),
      )
      .catch((error: unknown) => {
        deps.log.warn({ err: error, sessionId: snapshot.sessionId }, 'could not report the session end');
      });
  });

  void (async () => {
    try {
      const spec = snapshot.testRun;
      if (spec === null || !snapshot.policy.capabilities.includes('exec')) {
        throw new DomainError('TARGET_NOT_ALLOWED', 'not a test run, or the policy does not allow exec');
      }
      const connection = await connectToTarget(snapshot, deps, verifier);
      // The cancel runs on this connection: close it only once the run has ended and been recorded.
      bridge.onClosed(() => {
        void recorded().then(() => {
          connection.close();
        });
      });
      if (bridge.isClosed) return;
      if (verifier.presented !== undefined) {
        bridge.sendControl({ t: 'hostkey', ...verifier.presented, verified: true });
      }
      const sftp = await connection.sftp();
      run = runRemoteTests({
        connection,
        sftp,
        root: snapshot.target.remoteRoot,
        spec,
        bridge,
        record: async (outcome) => {
          try {
            await deps.controlPlane.reportRun(spec.runId, {
              ...outcome.result,
              sessionId: snapshot.sessionId,
            });
          } catch (error) {
            deps.log.warn({ err: error, runId: spec.runId }, 'could not report the test run');
          }
        },
      });
      // Handled below; a failure while the ACTIVE report is on its way must not be an unhandled rejection.
      run.catch(() => undefined);
      opened = true;
      bridge.sendControl({ t: 'status', state: 'ACTIVE' });
      await deps.controlPlane.report(snapshot.sessionId, {
        state: 'ACTIVE',
        reason: 'opened',
        brokerInstance: deps.instanceId,
        hostKey: presented(verifier),
      });
      await run;
    } catch (error) {
      failure = failureCode(error);
      deps.log.warn({ sessionId: snapshot.sessionId, code: failure }, 'test run session failed to open');
      bridge.sendControl({ t: 'error', code: failure, message: messageFor(failure) });
      bridge.close('connect_failed', failure);
    }
  })();
  return bridge;
}
