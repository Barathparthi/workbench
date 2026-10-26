import type { RedeemTicketResponse } from '@qe/contracts';
import {
  createHostKeyVerifier,
  isDomainError,
  mapSshError,
  type CredentialSource,
  type ErrorCode,
  type HostKeyVerifier,
  type SessionRegistry,
  type SshTransport,
  type StreamSocket,
  TerminalBridge,
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

/** A failure before the shell opens: the user sees the code, the control plane gets it as the close reason. */
class ConnectFailure extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

const presented = (v: HostKeyVerifier) =>
  v.presented === undefined || v.outcome === undefined ? undefined : { outcome: v.outcome, ...v.presented };

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
    const t = snapshot.target;
    try {
      if (t.jumpHostId !== null) throw new ConnectFailure('TARGET_NOT_ALLOWED'); // jump hosts: Phase 19
      if (!snapshot.policy.allowedPorts.includes(t.port)) throw new ConnectFailure('TARGET_NOT_ALLOWED');
      const address = await checkTargetHost(
        t.host,
        snapshot.policy.allowedCidrs,
        deps.deniedCidrs,
        deps.resolver,
      );
      if (!address.allowed) throw new ConnectFailure('TARGET_ADDRESS_FORBIDDEN');
      if (snapshot.credential === null) throw new ConnectFailure('CREDENTIALS_UNAVAILABLE');
      const credential = await deps.credentials.resolve(snapshot.credential, t.principal);
      if (bridge.isClosed) return;
      let connection;
      try {
        connection = await deps.transport.connect(
          { address: address.address, port: t.port, username: t.principal },
          credential,
          verifier,
        );
      } catch (error) {
        throw new ConnectFailure(mapSshError(error, verifier.outcome));
      }
      bridge.onClosed(() => {
        connection.close();
      });
      // The user may have closed the stream while we were connecting (the getter changes across awaits).
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
      failure =
        error instanceof ConnectFailure
          ? error.code
          : isDomainError(error)
            ? error.code
            : ('INTERNAL_ERROR' as const);
      deps.log.warn({ sessionId: snapshot.sessionId, code: failure }, 'remote session failed to open');
      bridge.sendControl({ t: 'error', code: failure, message: messageFor(failure) });
      bridge.close('connect_failed', failure);
    }
  })();
  return bridge;
}

/** Short, user-facing explanations (04_OPERATIONS/USER_GUIDE troubleshooting); never internal detail. */
export function messageFor(code: ErrorCode): string {
  switch (code) {
    case 'HOST_KEY_MISMATCH':
      return 'The remote system presented an unexpected host key. Do not retry; contact the lab admin.';
    case 'HOST_KEY_UNKNOWN':
      return 'The remote system has no approved host key yet.';
    case 'CREDENTIALS_REJECTED':
      return 'The remote system refused the credentials.';
    case 'CREDENTIALS_UNAVAILABLE':
      return 'Credentials are not available right now. Try again later.';
    case 'SSH_TIMEOUT':
      return 'The remote system did not answer in time.';
    case 'SSH_UNREACHABLE':
      return 'The remote system cannot be reached.';
    case 'TARGET_ADDRESS_FORBIDDEN':
    case 'TARGET_NOT_ALLOWED':
      return 'This connection is not allowed by policy.';
    default:
      return 'The remote session could not be opened.';
  }
}
