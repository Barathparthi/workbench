import type { BrokerFsRequest, FsOp, RedeemTicketResponse } from '@qe/contracts';
import { DomainError, isDomainError } from '@qe/domain';
import type { Kysely } from 'kysely';

import { writeAuditEvent } from './audit/audit-writer.js';
import type { Database } from './db/schema.js';
import { snapshotFor } from './remote-session-service.js';
import type { RequestContext } from './workspace-service.js';

/** Sends one operation to the broker holding (or about to open) the session's SFTP connection. */
export type BrokerFiles = (sessionId: string, op: FsOp, body: BrokerFsRequest) => Promise<unknown>;

export interface RemoteFileSettings {
  readonly broker: BrokerFiles;
  /** A files-session must be used within the ticket's lifetime, like a terminal's ticket must be redeemed. */
  readonly ticketTtlMs: number;
  readonly now?: () => Date;
  /** Same as the session service's: tells the broker to drop the session (best effort). */
  readonly closeOnBroker?: (sessionId: string) => Promise<void>;
}

const MUTATIONS: ReadonlySet<FsOp> = new Set(['write', 'mkdir', 'rename', 'delete']);

type FileAudit =
  | { action: 'REMOTE_FILE_WRITE'; metadata: { op: 'write' | 'mkdir'; path: string; size?: number } }
  | { action: 'REMOTE_FILE_DELETE'; metadata: { path: string; recursive: boolean } }
  | { action: 'REMOTE_FILE_RENAME'; metadata: { from: string; to: string } };

/** jsonb cannot hold NUL; such a path is refused by the broker anyway, but its attempt is still audited. */
const auditPath = (value: unknown): string =>
  (typeof value === 'string' ? value : '').slice(0, 4096).replace(/\0/g, '�');

/** What a change is audited as: the relative path(s) and size, never the content. */
function auditFor(op: FsOp, request: Record<string, unknown>): FileAudit | undefined {
  switch (op) {
    case 'write':
      return {
        action: 'REMOTE_FILE_WRITE',
        metadata: {
          op: 'write',
          path: auditPath(request.path),
          size:
            typeof request.contentBase64 === 'string'
              ? Buffer.byteLength(request.contentBase64, 'base64')
              : 0,
        },
      };
    case 'mkdir':
      return { action: 'REMOTE_FILE_WRITE', metadata: { op: 'mkdir', path: auditPath(request.path) } };
    case 'delete':
      return {
        action: 'REMOTE_FILE_DELETE',
        metadata: { path: auditPath(request.path), recursive: request.recursive === true },
      };
    case 'rename':
      return {
        action: 'REMOTE_FILE_RENAME',
        metadata: { from: auditPath(request.from), to: auditPath(request.to) },
      };
    default:
      return undefined;
  }
}

export type RemoteFileService = ReturnType<typeof createRemoteFileService>;

/**
 * Remote file operations on a `files` session (05_API_CONTRACTS §2.4, PHASE_09 §9.3). Only the session's owner may
 * use it (anyone else, administrators included, gets 404: reading someone's files is not session administration).
 * Every call rebuilds the snapshot, so a disabled target or a changed policy stops the session at once; changes
 * need the policy's `file_write` capability and are audited with paths and sizes only.
 */
export function createRemoteFileService(db: Kysely<Database>, settings: RemoteFileSettings) {
  const now = settings.now ?? (() => new Date());

  return {
    async run(
      ctx: RequestContext,
      sessionId: string,
      op: FsOp,
      request: Record<string, unknown>,
    ): Promise<unknown> {
      const at = now();
      const session = await db
        .selectFrom('sessions')
        .selectAll()
        .where('id', '=', sessionId)
        .executeTakeFirst();
      if (session === undefined || session.user_id !== ctx.principal.userId)
        throw new DomainError('NOT_FOUND');
      if (session.kind !== 'files') throw new DomainError('INVALID_REQUEST', 'not a files session');
      if (session.state === 'REVOKED') throw new DomainError('SESSION_REVOKED');
      const unused = session.state === 'AUTHORIZED';
      const live = session.state === 'CONNECTING' || session.state === 'ACTIVE';
      if (
        (!unused && !live) ||
        session.expires_at <= at ||
        (unused && new Date(session.created_at).getTime() <= at.getTime() - settings.ticketTtlMs)
      ) {
        throw new DomainError('SESSION_EXPIRED', 'open a new files session');
      }

      let snapshot: RedeemTicketResponse;
      try {
        snapshot = await db.transaction().execute(async (tx) => {
          // First use: AUTHORIZED → CONNECTING (once, even under concurrent first calls); the broker reports ACTIVE.
          if (unused) {
            await tx
              .updateTable('sessions')
              .set({ state: 'CONNECTING' })
              .where('id', '=', sessionId)
              .where('state', '=', 'AUTHORIZED')
              .execute();
          }
          return snapshotFor(tx, session);
        });
      } catch (error) {
        // The target was disabled or its policy changed: this session is over (a new one is decided afresh), so
        // its SFTP connection on the broker goes too.
        if (isDomainError(error) && error.code === 'TARGET_NOT_ALLOWED' && live) {
          await settings.closeOnBroker?.(sessionId).catch(() => undefined);
        }
        throw error;
      }

      const audit = MUTATIONS.has(op) ? auditFor(op, request) : undefined;
      const record = (result: 'success' | 'failure' | 'denied', reasonCode?: string) =>
        audit === undefined
          ? Promise.resolve()
          : db.transaction().execute((tx) =>
              writeAuditEvent(tx, {
                action: audit.action,
                actorType: 'user',
                actorUserId: ctx.principal.userId,
                resourceType: 'session',
                resourceId: sessionId,
                result,
                ...(reasonCode !== undefined && { reasonCode }),
                requestId: ctx.requestId,
                metadata: { targetId: snapshot.target.id, ...audit.metadata },
              }),
            );

      if (audit !== undefined && !snapshot.policy.capabilities.includes('file_write')) {
        await record('denied', 'capability_not_allowed');
        throw new DomainError('FORBIDDEN', 'this connection policy does not allow changing remote files', {
          details: { capability: 'file_write' },
        });
      }
      let result: unknown;
      try {
        result = await settings.broker(sessionId, op, { snapshot, request });
      } catch (error) {
        const code = isDomainError(error) ? error.code : 'INTERNAL_ERROR';
        await record(code === 'PATH_OUTSIDE_ROOT' || code === 'FORBIDDEN' ? 'denied' : 'failure', code);
        // Reads are not audited, but a path that leaves the remote root is a security signal for any operation.
        if (audit === undefined && code === 'PATH_OUTSIDE_ROOT') {
          await db.transaction().execute((tx) =>
            writeAuditEvent(tx, {
              action: 'ACCESS_DENIED',
              actorType: 'user',
              actorUserId: ctx.principal.userId,
              resourceType: 'session',
              resourceId: sessionId,
              result: 'denied',
              reasonCode: 'PATH_OUTSIDE_ROOT',
              requestId: ctx.requestId,
              metadata: {
                permission: 'remote:file_read',
                method: 'POST',
                route: `/api/v1/sessions/:id/fs/${op}`,
              },
            }),
          );
        }
        throw error;
      }
      await record('success');
      return result;
    },
  };
}
