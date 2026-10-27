import type { RedeemTicketResponse } from '@qe/contracts';
import {
  createHostKeyVerifier,
  createRemoteFileSystem,
  DomainError,
  type RemoteFileSystem,
  type SftpChannel,
  type SshConnection,
} from '@qe/broker-core';

import { connectToTarget, failureCode, presented, type RunnerDeps } from './session-runner.js';

/** Why a files-session ended (the close reason the control plane records). */
export type FilesCloseReason = 'idle_timeout' | 'expired' | 'revoked' | 'shutdown' | 'remote_closed';

/** Operations of one session run at most this many at a time on its SFTP channel (PHASE_09 §9.3). */
const CONCURRENCY = 4;
/** setTimeout's ceiling (~24.8 days); longer sessions are re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Live {
  readonly userId: string;
  readonly fs: RemoteFileSystem;
  readonly close: (reason: FilesCloseReason) => void;
  readonly run: <T>(work: (fs: RemoteFileSystem) => Promise<T>) => Promise<T>;
}

/**
 * Files-sessions on this broker replica: one SSH connection and one SFTP channel per session, opened on the first
 * operation with the snapshot the control plane sends, reused by later ones, and closed when idle (the policy's idle
 * timeout), at the session's expiry, on revocation or on shutdown. Opening and closing are reported to the control
 * plane like terminal sessions; an operation on a closed session reopens nothing (the control plane answers 410 and
 * the IDE opens a new session).
 */
export class FilesSessions {
  private readonly sessions = new Map<string, Promise<Live>>();
  private readonly settled = new Map<string, Live>();

  constructor(private readonly deps: RunnerDeps) {}

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Runs one operation on the session's file system, opening the session first if this broker has not yet. */
  async run<T>(snapshot: RedeemTicketResponse, work: (fs: RemoteFileSystem) => Promise<T>): Promise<T> {
    let live = this.sessions.get(snapshot.sessionId);
    if (live === undefined) {
      live = this.open(snapshot);
      this.sessions.set(snapshot.sessionId, live);
      live.catch(() => this.sessions.delete(snapshot.sessionId));
    }
    return (await live).run(work);
  }

  close(sessionId: string, reason: FilesCloseReason): boolean {
    const live = this.settled.get(sessionId);
    live?.close(reason);
    return live !== undefined;
  }

  closeUser(userId: string, reason: FilesCloseReason): number {
    const matching = [...this.settled.values()].filter((l) => l.userId === userId);
    for (const l of matching) l.close(reason);
    return matching.length;
  }

  closeAll(reason: FilesCloseReason): number {
    const all = [...this.settled.values()];
    for (const l of all) l.close(reason);
    return all.length;
  }

  private async open(snapshot: RedeemTicketResponse): Promise<Live> {
    const { deps } = this;
    const id = snapshot.sessionId;
    const verifier = createHostKeyVerifier(snapshot.hostKeys);
    let connection: SshConnection;
    let sftp: SftpChannel;
    try {
      connection = await connectToTarget(snapshot, deps, verifier);
      try {
        sftp = await connection.sftp();
      } catch (error) {
        connection.close();
        throw error;
      }
    } catch (error) {
      const code = failureCode(error);
      deps.log.warn({ sessionId: id, code }, 'files session failed to open');
      void deps.controlPlane
        .report(id, {
          state: 'FAILED',
          reason: code,
          brokerInstance: deps.instanceId,
          hostKey: presented(verifier),
        })
        .catch(() => undefined);
      throw error;
    }

    let closed = false;
    let running = 0;
    const waiting: (() => void)[] = [];
    let idle: NodeJS.Timeout | undefined;
    let expiry: NodeJS.Timeout | undefined;
    const idleMs = snapshot.policy.idleTimeoutSec * 1000;

    const close = (reason: FilesCloseReason) => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      clearTimeout(expiry);
      this.sessions.delete(id);
      this.settled.delete(id);
      sftp.close();
      connection.close();
      void deps.controlPlane
        .report(id, { state: 'CLOSED', reason, brokerInstance: deps.instanceId, bytesIn: 0, bytesOut: 0 })
        .catch((error: unknown) => {
          deps.log.warn({ err: error, sessionId: id }, 'could not report the session end');
        });
    };
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => {
          // Idle means no operation for the policy's idle timeout, not "an operation is taking long".
          if (running > 0) armIdle();
          else close('idle_timeout');
        },
        Math.min(idleMs, MAX_TIMER_MS),
      );
    };
    const armExpiry = () => {
      const left = new Date(snapshot.expiresAt).getTime() - Date.now();
      expiry = setTimeout(
        () => {
          if (Date.now() >= new Date(snapshot.expiresAt).getTime()) close('expired');
          else armExpiry();
        },
        Math.max(0, Math.min(left, MAX_TIMER_MS)),
      );
    };
    connection.onClose(() => {
      close('remote_closed');
    });
    armIdle();
    armExpiry();

    const fs = createRemoteFileSystem(sftp, {
      remoteRoot: snapshot.target.remoteRoot,
      canWrite: snapshot.policy.capabilities.includes('file_write'),
    });
    const live: Live = {
      userId: snapshot.user.id,
      fs,
      close,
      run: async (work) => {
        if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
        // Closed while this call waited (idle, revoked, …): the IDE opens a new session.
        if (closed) throw new DomainError('SESSION_EXPIRED');
        running++;
        armIdle();
        try {
          return await work(fs);
        } finally {
          running--;
          waiting.shift()?.();
          // close() may have run while the work was awaited.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (!closed) armIdle();
        }
      },
    };
    this.settled.set(id, live);
    // Best effort, like every report: the session works either way and the control plane's sweep repairs its state.
    void deps.controlPlane
      .report(id, {
        state: 'ACTIVE',
        reason: 'opened',
        brokerInstance: deps.instanceId,
        hostKey: presented(verifier),
      })
      .catch((error: unknown) => {
        deps.log.warn({ err: error, sessionId: id }, 'could not report the session start');
      });
    return live;
  }
}
