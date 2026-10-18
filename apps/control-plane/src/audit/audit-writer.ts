import { createHash } from 'node:crypto';

import { AuditMetadata, type AuditAction, type AuditActorType, type AuditResult } from '@qe/contracts';
import { DomainError } from '@qe/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type { Database } from '../db/schema.js';
import { canonicalJson } from './canonical-json.js';

/** Serialises writers so each event chains onto the latest one (pg_advisory_xact_lock key). */
const AUDIT_CHAIN_LOCK = 4_242_002;

export interface AuditEventInput<A extends AuditAction = AuditAction> {
  readonly action: A;
  readonly actorType: AuditActorType;
  readonly actorUserId: string | null;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly result: AuditResult;
  readonly reasonCode?: string;
  readonly requestId?: string;
  readonly metadata: unknown;
}

interface ChainedFields {
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: string;
  reasonCode: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

export function eventHash(prev: Buffer | null, fields: ChainedFields): Buffer {
  return createHash('sha256')
    .update(prev ?? Buffer.alloc(0))
    .update(canonicalJson(fields))
    .digest();
}

/**
 * Writes one audit event inside the caller's transaction (03 §3.6): metadata must match the action's
 * allowlist, and the event's hash chains onto the previous one. A failure throws, so the caller's
 * transaction — and the privileged action with it — is rolled back (fail closed).
 */
export async function writeAuditEvent(tx: Transaction<Database>, event: AuditEventInput): Promise<string> {
  const parsed = AuditMetadata[event.action].safeParse(event.metadata);
  if (!parsed.success) {
    throw new DomainError('INTERNAL_ERROR', `audit metadata for ${event.action} is not allowed`, {
      details: { keys: Object.keys(event.metadata ?? {}) },
    });
  }
  await sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`.execute(tx);
  const previous = await tx
    .selectFrom('audit_events')
    .select('hash')
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  const fields: ChainedFields = {
    id: uuidv7(),
    occurredAt: new Date(),
    actorUserId: event.actorUserId,
    actorType: event.actorType,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    result: event.result,
    reasonCode: event.reasonCode ?? null,
    requestId: event.requestId ?? null,
    metadata: parsed.data,
  };
  const prevHash = previous?.hash ?? null;
  await tx
    .insertInto('audit_events')
    .values({
      id: fields.id,
      occurred_at: fields.occurredAt,
      actor_user_id: fields.actorUserId,
      actor_type: event.actorType,
      action: fields.action,
      resource_type: fields.resourceType,
      resource_id: fields.resourceId,
      result: event.result,
      reason_code: fields.reasonCode,
      request_id: fields.requestId,
      trace_id: null,
      session_id: null,
      client_ip: null,
      metadata_json: JSON.stringify(fields.metadata),
      prev_hash: prevHash,
      hash: eventHash(prevHash, fields),
    })
    .execute();
  return fields.id;
}

/** Recomputes the chain; returns the first event whose stored hash or link does not match. */
export async function verifyAuditChain(
  db: Kysely<Database>,
): Promise<{ ok: true; events: number } | { ok: false; brokenAt: string }> {
  const rows = await db.selectFrom('audit_events').selectAll().orderBy('seq', 'asc').execute();
  let prev: Buffer | null = null;
  for (const row of rows) {
    const expected = eventHash(prev, {
      id: row.id,
      occurredAt: row.occurred_at,
      actorUserId: row.actor_user_id,
      actorType: row.actor_type,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      result: row.result,
      reasonCode: row.reason_code,
      requestId: row.request_id,
      metadata: row.metadata_json,
    });
    const linked =
      prev === null ? row.prev_hash === null : row.prev_hash !== null && row.prev_hash.equals(prev);
    if (!linked || !row.hash.equals(expected)) return { ok: false, brokenAt: row.id };
    prev = row.hash;
  }
  return { ok: true, events: rows.length };
}
