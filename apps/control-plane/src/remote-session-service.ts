import { randomBytes } from 'node:crypto';

import type { OpenSessionRequest, RedeemTicketResponse, SessionStateReport } from '@qe/contracts';
import { DomainError, type SessionState } from '@qe/domain';
import { evaluateConnection, type PolicyView } from '@qe/policy';
import { sql, type Kysely, type Selectable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import { sha256 } from './auth.js';
import { writeAuditEvent } from './audit/audit-writer.js';
import type { Database, SessionsTable } from './db/schema.js';
import { WorkspacesRepo } from './repos/workspaces.js';
import type { RequestContext } from './workspace-service.js';

export interface RemoteSessionSettings {
  readonly ticketTtlMs: number;
  /** Origins a session may be opened from (the IDE); the ticket is bound to the one used. */
  readonly allowedOrigins: readonly string[];
  readonly now?: () => Date;
  /** Tells the broker holding a live session to close it (revocation); best effort, the broker also expires it. */
  readonly closeOnBroker?: (sessionId: string) => Promise<void>;
}

/** Sessions that count against a user's limit: open, or authorized with a ticket still usable. */
const OPEN_STATES: SessionState[] = ['CONNECTING', 'ACTIVE', 'CLOSING'];

const iso = (d: Date | string) => new Date(d).toISOString();
const toSessionDto = (s: Selectable<SessionsTable>) => ({
  id: s.id,
  kind: s.kind,
  state: s.state,
  targetId: s.target_id,
  workspaceId: s.workspace_id,
  createdAt: iso(s.created_at),
  expiresAt: iso(s.expires_at),
  closedAt: s.closed_at === null ? null : iso(s.closed_at),
  closeReason: s.close_reason,
});

/** `{{user.username}}` or a fixed service account (08 §5). */
export const principalFor = (template: string, username: string): string =>
  template === '{{user.username}}' ? username : template;

export type RemoteSessionService = ReturnType<typeof createRemoteSessionService>;

/** Remote sessions and their single-use tickets (Phase 07 §7.5): the last step before the broker connects. */
export function createRemoteSessionService(db: Kysely<Database>, settings: RemoteSessionSettings) {
  const now = settings.now ?? (() => new Date());
  const origins = new Set(settings.allowedOrigins.map((o) => new URL(o).origin));

  const countOpen = async (userId: string, at: Date) => {
    const r = await db
      .selectFrom('sessions')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .where((eb) =>
        eb.or([
          eb('state', 'in', OPEN_STATES),
          eb.and([
            eb('state', '=', 'AUTHORIZED'),
            eb('created_at', '>', new Date(at.getTime() - settings.ticketTtlMs)),
          ]),
        ]),
      )
      .where('expires_at', '>', at)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  };

  return {
    /**
     * Authorizes a session and mints its ticket. Order matters: visibility (404), then the policy decision
     * (audited allow or deny), and only then a ticket — nothing touches the network here.
     */
    async open(ctx: RequestContext, targetId: string, input: OpenSessionRequest, origin: string | undefined) {
      if (origin === undefined || !origins.has(origin)) {
        throw new DomainError('CSRF_REJECTED', 'sessions are opened from the IDE');
      }
      const row = await db
        .selectFrom('targets as t')
        .innerJoin('connection_policies as p', 'p.id', 't.policy_id')
        .select([
          't.id',
          't.status',
          'p.allowed_roles',
          'p.capabilities',
          'p.max_sessions_per_user',
          'p.idle_timeout_sec',
          'p.max_session_sec',
          'p.version',
        ])
        .where('t.id', '=', targetId)
        .executeTakeFirst();
      // Invisible to callers whose roles the policy does not name (no enumeration), unless they administer targets.
      if (
        row === undefined ||
        (!ctx.principal.permissions.has('target:admin') &&
          !row.allowed_roles.some((r) => ctx.principal.roles.includes(r)))
      ) {
        throw new DomainError('NOT_FOUND');
      }
      if (input.workspaceId !== undefined) {
        const ws = await new WorkspacesRepo(db).findVisible(input.workspaceId, ctx.principal.userId);
        if (ws === undefined) throw new DomainError('NOT_FOUND');
      }

      const at = now();
      const policy: PolicyView = {
        allowedRoles: row.allowed_roles,
        capabilities: row.capabilities,
        maxSessionsPerUser: row.max_sessions_per_user,
        idleTimeoutSec: row.idle_timeout_sec,
        maxSessionSec: row.max_session_sec,
        version: row.version,
      };
      const decision = evaluateConnection(
        ctx.principal,
        row,
        policy,
        input.kind,
        await countOpen(ctx.principal.userId, at),
      );

      if (!decision.allowed) {
        await db.transaction().execute((tx) =>
          writeAuditEvent(tx, {
            action: 'REMOTE_CONNECT_DENIED',
            actorType: 'user',
            actorUserId: ctx.principal.userId,
            resourceType: 'target',
            resourceId: targetId,
            result: 'denied',
            reasonCode: decision.reason,
            requestId: ctx.requestId,
            metadata: { targetId, kind: input.kind, reason: decision.reason },
          }),
        );
        throw new DomainError(decision.code, 'not allowed to connect to this target', {
          details: { reason: decision.reason },
        });
      }

      const sessionId = uuidv7();
      const ticket = randomBytes(32).toString('base64url');
      const expiresAt = new Date(at.getTime() + decision.maxSessionSec * 1000);
      await db.transaction().execute(async (tx) => {
        await tx
          .insertInto('sessions')
          .values({
            id: sessionId,
            user_id: ctx.principal.userId,
            workspace_id: input.workspaceId ?? null,
            target_id: targetId,
            kind: input.kind,
            state: 'AUTHORIZED',
            policy_version: decision.policyVersion,
            created_at: at,
            expires_at: expiresAt,
          })
          .execute();
        await tx
          .insertInto('session_tickets')
          .values({
            ticket_hash: sha256(ticket),
            session_id: sessionId,
            user_id: ctx.principal.userId,
            origin,
            expires_at: new Date(at.getTime() + settings.ticketTtlMs),
          })
          .execute();
        await writeAuditEvent(tx, {
          action: 'REMOTE_CONNECT_ALLOWED',
          actorType: 'user',
          actorUserId: ctx.principal.userId,
          resourceType: 'target',
          resourceId: targetId,
          result: 'success',
          requestId: ctx.requestId,
          metadata: { targetId, kind: input.kind, policyVersion: decision.policyVersion },
        });
      });
      return {
        sessionId,
        kind: input.kind,
        state: 'AUTHORIZED' as const,
        streamUrl: `/api/v1/sessions/${sessionId}/stream`,
        ticket,
        expiresAt: expiresAt.toISOString(),
        idleTimeoutSec: decision.idleTimeoutSec,
      };
    },

    async listMine(ctx: RequestContext) {
      const rows = await db
        .selectFrom('sessions')
        .selectAll()
        .where('user_id', '=', ctx.principal.userId)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return rows.map(toSessionDto);
    },

    /** Own sessions, or anyone's with `session:admin`; others are invisible (404). */
    async get(ctx: RequestContext, id: string) {
      const s = await db.selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst();
      if (
        s === undefined ||
        (s.user_id !== ctx.principal.userId && !ctx.principal.permissions.has('session:admin'))
      ) {
        throw new DomainError('NOT_FOUND');
      }
      return s;
    },

    /**
     * Ends a session: unused → EXPIRED; live → CLOSING (the broker finishes it, Phase 08), or REVOKED when an
     * administrator ends someone else's. Already finished sessions are left as they are (idempotent).
     */
    async close(ctx: RequestContext, id: string) {
      const s = await this.get(ctx, id);
      const byAdmin = s.user_id !== ctx.principal.userId;
      const to: SessionState | undefined =
        s.state === 'AUTHORIZED'
          ? 'EXPIRED'
          : s.state === 'ACTIVE'
            ? byAdmin
              ? 'REVOKED'
              : 'CLOSING'
            : undefined;
      if (to === undefined) return toSessionDto(s);
      const reason = byAdmin ? 'revoked_by_admin' : 'closed_by_user';
      const result = await db.transaction().execute(async (tx) => {
        const row = await tx
          .updateTable('sessions')
          .set({ state: to, close_reason: reason, ...(to === 'EXPIRED' && { closed_at: now() }) })
          .where('id', '=', id)
          .where('state', '=', s.state)
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) return toSessionDto(s); // lost a race: someone else moved it
        await writeAuditEvent(tx, {
          action: 'REMOTE_SESSION_CLOSED',
          actorType: 'user',
          actorUserId: ctx.principal.userId,
          resourceType: 'session',
          resourceId: id,
          result: 'success',
          requestId: ctx.requestId,
          metadata: { reason },
        });
        return toSessionDto(row);
      });
      // A live session ends on the broker; it reports CLOSED back (reportState).
      if (s.state === 'ACTIVE' && result.state !== 'ACTIVE') {
        await settings.closeOnBroker?.(id).catch(() => undefined);
      }
      return result;
    },

    /**
     * Broker-only: what happened to a session (Phase 08 §8.3). Moves CONNECTING -> ACTIVE, CONNECTING -> FAILED, or a
     * live/closing session -> CLOSED, each audited; host-key problems and refused addresses get their own security
     * events. Reports that do not fit the current state are ignored (idempotent: retries and races are harmless).
     */
    async reportState(id: string, report: SessionStateReport): Promise<{ state: SessionState }> {
      const at = now();
      return db.transaction().execute(async (tx) => {
        const s = await tx
          .selectFrom('sessions')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (s === undefined) throw new DomainError('NOT_FOUND');
        type SshAction =
          | 'SSH_SESSION_OPENED'
          | 'SSH_SESSION_CLOSED'
          | 'SSH_CONNECT_FAILED'
          | 'SSH_HOST_KEY_MISMATCH'
          | 'SSH_HOST_KEY_UNKNOWN'
          | 'SSRF_BLOCKED';
        const audit = (
          action: SshAction,
          result: 'success' | 'failure' | 'denied',
          metadata: Record<string, unknown>,
          reasonCode?: string,
        ) =>
          writeAuditEvent(tx, {
            action,
            actorType: 'service',
            actorUserId: s.user_id,
            resourceType: 'session',
            resourceId: id,
            result,
            ...(reasonCode !== undefined && { reasonCode }),
            metadata,
          });

        if (report.state === 'ACTIVE' && s.state === 'CONNECTING') {
          await tx
            .updateTable('sessions')
            .set({
              state: 'ACTIVE',
              activated_at: at,
              last_activity_at: at,
              broker_instance: report.brokerInstance,
            })
            .where('id', '=', id)
            .execute();
          await audit('SSH_SESSION_OPENED', 'success', {
            brokerInstance: report.brokerInstance,
            fingerprintSha256: report.hostKey?.fingerprintSha256 ?? 'unknown',
          });
          return { state: 'ACTIVE' as const };
        }

        if (report.state === 'FAILED' && s.state === 'CONNECTING') {
          await tx
            .updateTable('sessions')
            .set({
              state: 'FAILED',
              close_reason: report.reason,
              closed_at: at,
              broker_instance: report.brokerInstance,
            })
            .where('id', '=', id)
            .execute();
          await audit('SSH_CONNECT_FAILED', 'failure', { reason: report.reason }, report.reason);
          const key = report.hostKey;
          if (key !== undefined && key.outcome !== 'match') {
            await audit(
              key.outcome === 'mismatch' ? 'SSH_HOST_KEY_MISMATCH' : 'SSH_HOST_KEY_UNKNOWN',
              'denied',
              { algorithm: key.algorithm, presentedFingerprint: key.fingerprintSha256 },
              key.outcome,
            );
          }
          if (report.reason === 'TARGET_ADDRESS_FORBIDDEN') {
            await audit(
              'SSRF_BLOCKED',
              'denied',
              { host: s.target_id ?? 'unknown', reason: 'at_connect' },
              'at_connect',
            );
          }
          return { state: 'FAILED' as const };
        }

        if (
          report.state === 'CLOSED' &&
          (s.state === 'ACTIVE' || s.state === 'CLOSING' || s.state === 'REVOKED')
        ) {
          const reason = s.close_reason ?? report.reason;
          await tx
            .updateTable('sessions')
            .set({ state: 'CLOSED', close_reason: reason, closed_at: at })
            .where('id', '=', id)
            .execute();
          const started = s.activated_at ?? new Date(s.created_at);
          await audit('SSH_SESSION_CLOSED', 'success', {
            reason,
            bytesIn: report.bytesIn ?? 0,
            bytesOut: report.bytesOut ?? 0,
            durationSec: Math.max(0, Math.round((at.getTime() - started.getTime()) / 1000)),
          });
          return { state: 'CLOSED' as const };
        }
        return { state: s.state };
      });
    },

    /**
     * Broker-only: redeems a ticket exactly once (atomic update), checks it is unexpired and bound to the same
     * Origin, and returns the frozen snapshot to connect with. Session moves AUTHORIZED → CONNECTING.
     */
    async redeem(ticket: string, origin: string): Promise<RedeemTicketResponse> {
      const at = now();
      // Burn the ticket first, in its own statement: any attempt — even one that fails a later check, such as a
      // wrong Origin — uses it up, so a stolen ticket cannot be retried.
      const t = await db
        .updateTable('session_tickets')
        .set({ redeemed_at: at })
        .where('ticket_hash', '=', sha256(ticket))
        .where('redeemed_at', 'is', null)
        .where('expires_at', '>', at)
        .returning(['session_id', 'origin'])
        .executeTakeFirst();
      if (t === undefined || t.origin !== origin) throw new DomainError('AUTH_REQUIRED', 'ticket invalid');
      return db.transaction().execute(async (tx) => {
        const s = await tx
          .updateTable('sessions')
          .set({ state: 'CONNECTING' })
          .where('id', '=', t.session_id)
          .where('state', '=', 'AUTHORIZED')
          .where('expires_at', '>', at)
          .returningAll()
          .executeTakeFirst();
        if (s?.target_id == null) throw new DomainError('AUTH_REQUIRED', 'ticket invalid');
        const target = await tx
          .selectFrom('targets')
          .selectAll()
          .where('id', '=', s.target_id)
          .executeTakeFirstOrThrow();
        const policy = await tx
          .selectFrom('connection_policies')
          .selectAll()
          .where('id', '=', target.policy_id)
          .executeTakeFirstOrThrow();
        // The policy may have changed since authorization: refuse a session authorized under an older version.
        if (target.status !== 'active' || policy.version !== s.policy_version) {
          throw new DomainError('TARGET_NOT_ALLOWED', 'the target or its policy changed');
        }
        const user = await tx
          .selectFrom('users')
          .select(['id', 'username'])
          .where('id', '=', s.user_id)
          .executeTakeFirstOrThrow();
        const keys = await tx
          .selectFrom('target_host_keys')
          .select(['algorithm', 'fingerprint_sha256'])
          .where('target_id', '=', target.id)
          .where('status', '=', 'trusted')
          .execute();
        const credential =
          target.credential_ref_id === null
            ? undefined
            : await tx
                .selectFrom('credential_refs')
                .selectAll()
                .where('id', '=', target.credential_ref_id)
                .executeTakeFirst();
        return {
          sessionId: s.id,
          kind: s.kind,
          expiresAt: s.expires_at.toISOString(),
          terminal: null,
          user: { id: user.id, username: user.username },
          target: {
            id: target.id,
            name: target.name,
            host: target.host,
            port: target.port,
            os: target.os,
            principal: principalFor(target.principal_template, user.username),
            remoteRoot: target.remote_root,
            jumpHostId: target.jump_host_id,
          },
          policy: {
            id: policy.id,
            version: policy.version,
            allowedCidrs: policy.allowed_cidrs,
            allowedPorts: policy.allowed_ports,
            capabilities: policy.capabilities,
            idleTimeoutSec: policy.idle_timeout_sec,
            maxSessionSec: policy.max_session_sec,
          },
          hostKeys: keys.map((k) => ({ algorithm: k.algorithm, fingerprintSha256: k.fingerprint_sha256 })),
          credential:
            credential === undefined
              ? null
              : {
                  provider: credential.provider,
                  method: credential.method,
                  providerPath: credential.provider_path,
                  metadata: credential.metadata_json,
                },
        };
      });
    },

    /** Removes used and expired tickets (housekeeping). */
    async purgeTickets() {
      await db
        .deleteFrom('session_tickets')
        .where((eb) =>
          eb.or([
            eb('redeemed_at', 'is not', null),
            eb('expires_at', '<', sql<Date>`now() - interval '1 day'`),
          ]),
        )
        .execute();
    },
  };
}
