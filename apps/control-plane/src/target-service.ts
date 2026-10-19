import { createHash } from 'node:crypto';

import type {
  AddHostKeyRequest,
  CreatePolicyRequest,
  RegisterTargetRequest,
  Target,
  UpdatePolicyRequest,
  UpdateTargetRequest,
} from '@qe/contracts';
import { DomainError } from '@qe/domain';
import { canSeeTarget, checkTargetHost, isValidCidr, type Resolver } from '@qe/policy';
import { isKnownRole } from '@qe/rbac';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import { writeAuditEvent, type AuditEventInput } from './audit/audit-writer.js';
import type {
  ConnectionPoliciesTable,
  CredentialRefsTable,
  Database,
  TargetHostKeysTable,
  TargetsTable,
} from './db/schema.js';
import { isUniqueViolation } from './repos/workspaces.js';
import type { RequestContext } from './workspace-service.js';

type PolicyRow = Selectable<ConnectionPoliciesTable>;
type TargetRow = Selectable<TargetsTable>;
type HostKeyRow = Selectable<TargetHostKeysTable>;

export interface TargetSettings {
  /** Networks no target may resolve to (cluster, platform). */
  readonly deniedCidrs: readonly string[];
  readonly resolver: Resolver;
}

/** OpenSSH `SHA256:` fingerprint of a public key blob, as `ssh-keygen -lf` prints it. */
export const sha256Fingerprint = (blob: Buffer): string =>
  `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;

/**
 * Parses an OpenSSH public key line (`<algorithm> <base64> [comment]`). The algorithm inside the blob must match the
 * one in front of it, so a mislabeled key cannot be approved.
 */
export function parsePublicKey(line: string): {
  algorithm: string;
  fingerprintSha256: string;
  publicKey: string;
} {
  const [algorithm, data] = line.trim().split(/\s+/);
  if (algorithm === undefined || data === undefined)
    throw new DomainError('INVALID_REQUEST', 'not a public key');
  const blob = Buffer.from(data, 'base64');
  const nameLength = blob.length >= 4 ? blob.readUInt32BE(0) : -1;
  const inner = nameLength > 0 && nameLength <= 64 ? blob.subarray(4, 4 + nameLength).toString('ascii') : '';
  // rsa-sha2-* keys are stored as ssh-rsa blobs.
  const expected = algorithm.startsWith('rsa-sha2-') ? 'ssh-rsa' : algorithm;
  if (inner !== expected) throw new DomainError('INVALID_REQUEST', 'the key type does not match its data');
  return { algorithm, fingerprintSha256: sha256Fingerprint(blob), publicKey: `${algorithm} ${data}` };
}

const iso = (d: Date | string) => new Date(d).toISOString();

export const toPolicyDto = (p: PolicyRow) => ({
  id: p.id,
  name: p.name,
  allowedRoles: p.allowed_roles,
  allowedCidrs: p.allowed_cidrs,
  allowedPorts: p.allowed_ports,
  capabilities: p.capabilities,
  idleTimeoutSec: p.idle_timeout_sec,
  maxSessionSec: p.max_session_sec,
  maxSessionsPerUser: p.max_sessions_per_user,
  version: p.version,
  createdAt: iso(p.created_at),
  updatedAt: iso(p.updated_at),
});

export const toTargetDto = (t: TargetRow, keys: HostKeyRow[]): Target => ({
  id: t.id,
  name: t.name,
  description: t.description,
  host: t.host,
  port: t.port,
  os: t.os,
  principalTemplate: t.principal_template,
  remoteRoot: t.remote_root,
  policyId: t.policy_id,
  credentialRefId: t.credential_ref_id,
  jumpHostId: t.jump_host_id,
  tags: t.tags,
  status: t.status,
  hostKeys: keys.map((k) => ({
    id: k.id,
    algorithm: k.algorithm,
    fingerprintSha256: k.fingerprint_sha256,
    status: k.status,
    approvedAt: k.approved_at === null ? null : iso(k.approved_at),
  })),
  createdAt: iso(t.created_at),
  updatedAt: iso(t.updated_at),
});

const toCredentialDto = (c: Selectable<CredentialRefsTable>) => ({
  id: c.id,
  provider: c.provider,
  method: c.method,
  providerPath: c.provider_path,
  metadata: c.metadata_json,
  createdAt: iso(c.created_at),
});

export type TargetService = ReturnType<typeof createTargetService>;

/** Targets, connection policies, host keys and credential references (Phase 07 §7.1–7.4). */
export function createTargetService(db: Kysely<Database>, settings: TargetSettings) {
  const audit = (
    tx: Transaction<Database>,
    ctx: RequestContext,
    event: Omit<AuditEventInput, 'actorType' | 'actorUserId' | 'requestId' | 'result'> & {
      result?: AuditEventInput['result'];
    },
  ) =>
    writeAuditEvent(tx, {
      actorType: 'user',
      actorUserId: ctx.principal.userId,
      requestId: ctx.requestId,
      result: 'success',
      ...event,
    });

  const policyOr404 = async (id: string, q: Kysely<Database> = db) => {
    const p = await q.selectFrom('connection_policies').selectAll().where('id', '=', id).executeTakeFirst();
    if (p === undefined) throw new DomainError('NOT_FOUND');
    return p;
  };
  const targetOr404 = async (id: string, q: Kysely<Database> = db) => {
    const t = await q.selectFrom('targets').selectAll().where('id', '=', id).executeTakeFirst();
    if (t === undefined) throw new DomainError('NOT_FOUND');
    return t;
  };
  const keysOf = (ids: string[]) =>
    ids.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom('target_host_keys')
          .selectAll()
          .where('target_id', 'in', ids)
          .orderBy('approved_at')
          .execute();

  const validatePolicy = (input: {
    allowedRoles?: string[] | undefined;
    allowedCidrs?: string[] | undefined;
  }) => {
    const badRole = input.allowedRoles?.find((r) => !isKnownRole(r));
    if (badRole !== undefined) {
      throw new DomainError('INVALID_REQUEST', 'unknown role', { details: { field: 'allowedRoles' } });
    }
    const badCidr = input.allowedCidrs?.find((c) => !isValidCidr(c));
    if (badCidr !== undefined) {
      throw new DomainError('INVALID_REQUEST', 'invalid CIDR', { details: { field: 'allowedCidrs' } });
    }
  };

  /**
   * SSRF check at registration (admins get immediate feedback; the broker checks again at every connect). A refusal
   * is audited in its own transaction, before the caller's, so the evidence survives the rollback.
   */
  const checkHost = async (ctx: RequestContext, host: string, policy: PolicyRow) => {
    const decision = await checkTargetHost(
      host,
      policy.allowed_cidrs,
      settings.deniedCidrs,
      settings.resolver,
    );
    if (decision.allowed) return;
    await db.transaction().execute((t) =>
      audit(t, ctx, {
        action: 'SSRF_BLOCKED',
        resourceType: 'target',
        resourceId: null,
        result: 'denied',
        reasonCode: decision.reason,
        metadata: { host, reason: decision.reason },
      }),
    );
    throw new DomainError(
      'TARGET_ADDRESS_FORBIDDEN',
      'the host resolves to an address this policy does not allow',
      {
        details: { reason: decision.reason },
      },
    );
  };

  /** A target becomes connectable only with a trusted host key and a credential reference. */
  const canActivate = async (t: TargetRow, q: Kysely<Database>) =>
    t.credential_ref_id !== null &&
    (await q
      .selectFrom('target_host_keys')
      .select('id')
      .where('target_id', '=', t.id)
      .where('status', '=', 'trusted')
      .executeTakeFirst()) !== undefined;

  return {
    // ── policies ──
    async listPolicies() {
      return (await db.selectFrom('connection_policies').selectAll().orderBy('name').execute()).map(
        toPolicyDto,
      );
    },

    async createPolicy(ctx: RequestContext, input: CreatePolicyRequest) {
      validatePolicy(input);
      try {
        return await db.transaction().execute(async (tx) => {
          const row = await tx
            .insertInto('connection_policies')
            .values({
              id: uuidv7(),
              name: input.name,
              allowed_roles: input.allowedRoles,
              allowed_cidrs: input.allowedCidrs,
              allowed_ports: input.allowedPorts,
              capabilities: [...new Set(input.capabilities)],
              idle_timeout_sec: input.idleTimeoutSec,
              max_session_sec: input.maxSessionSec,
              max_sessions_per_user: input.maxSessionsPerUser,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await audit(tx, ctx, {
            action: 'POLICY_CREATE',
            resourceType: 'policy',
            resourceId: row.id,
            metadata: { name: row.name },
          });
          return toPolicyDto(row);
        });
      } catch (error) {
        throw isUniqueViolation(error)
          ? new DomainError('CONFLICT', 'a policy with this name exists')
          : error;
      }
    },

    /** Every change bumps `version`; sessions record the version they were authorized under. */
    async updatePolicy(ctx: RequestContext, id: string, input: UpdatePolicyRequest) {
      validatePolicy(input);
      await policyOr404(id);
      return db.transaction().execute(async (tx) => {
        const row = await tx
          .updateTable('connection_policies')
          .set({
            ...(input.allowedRoles !== undefined && { allowed_roles: input.allowedRoles }),
            ...(input.allowedCidrs !== undefined && { allowed_cidrs: input.allowedCidrs }),
            ...(input.allowedPorts !== undefined && { allowed_ports: input.allowedPorts }),
            ...(input.capabilities !== undefined && { capabilities: [...new Set(input.capabilities)] }),
            ...(input.idleTimeoutSec !== undefined && { idle_timeout_sec: input.idleTimeoutSec }),
            ...(input.maxSessionSec !== undefined && { max_session_sec: input.maxSessionSec }),
            ...(input.maxSessionsPerUser !== undefined && {
              max_sessions_per_user: input.maxSessionsPerUser,
            }),
            version: sql`version + 1`,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, ctx, {
          action: 'POLICY_UPDATE',
          resourceType: 'policy',
          resourceId: id,
          metadata: { name: row.name, version: row.version },
        });
        return toPolicyDto(row);
      });
    },

    // ── credential references ──
    async createCredentialRef(
      ctx: RequestContext,
      input: { provider: string; method: string; providerPath: string; metadata: Record<string, unknown> },
    ) {
      return db.transaction().execute(async (tx) => {
        const row = await tx
          .insertInto('credential_refs')
          .values({
            id: uuidv7(),
            provider: input.provider,
            method: input.method,
            provider_path: input.providerPath,
            metadata_json: JSON.stringify(input.metadata),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, ctx, {
          action: 'CREDENTIAL_REF_CREATE',
          resourceType: 'credential_ref',
          resourceId: row.id,
          metadata: { provider: row.provider, method: row.method },
        });
        return toCredentialDto(row);
      });
    },

    // ── targets ──
    /** Admins see every target; others only active targets whose policy names one of their roles. */
    async listTargets(ctx: RequestContext) {
      const admin = ctx.principal.permissions.has('target:admin');
      const rows = await db
        .selectFrom('targets')
        .innerJoin('connection_policies as p', 'p.id', 'targets.policy_id')
        .selectAll('targets')
        .select('p.allowed_roles')
        .$if(!admin, (q) => q.where('targets.status', '=', 'active'))
        .orderBy('targets.name')
        .execute();
      const visible = admin
        ? rows
        : rows.filter((r) => canSeeTarget(ctx.principal, { allowedRoles: r.allowed_roles }));
      const keys = await keysOf(visible.map((r) => r.id));
      return visible.map((r) =>
        toTargetDto(
          r,
          keys.filter((k) => k.target_id === r.id),
        ),
      );
    },

    async getTarget(ctx: RequestContext, id: string) {
      const t = await targetOr404(id);
      if (!ctx.principal.permissions.has('target:admin')) {
        const p = await policyOr404(t.policy_id);
        if (t.status !== 'active' || !canSeeTarget(ctx.principal, { allowedRoles: p.allowed_roles })) {
          throw new DomainError('NOT_FOUND');
        }
      }
      return toTargetDto(t, await keysOf([t.id]));
    },

    async registerTarget(ctx: RequestContext, input: RegisterTargetRequest) {
      const policy = await policyOr404(input.policyId);
      if (!policy.allowed_ports.includes(input.port)) {
        throw new DomainError('INVALID_REQUEST', 'the port is not allowed by the policy', {
          details: { field: 'port' },
        });
      }
      if (input.credentialRefId !== undefined) {
        const c = await db
          .selectFrom('credential_refs')
          .select('id')
          .where('id', '=', input.credentialRefId)
          .executeTakeFirst();
        if (c === undefined)
          throw new DomainError('INVALID_REQUEST', 'unknown credential', {
            details: { field: 'credentialRefId' },
          });
      }
      if (input.jumpHostId !== undefined) await targetOr404(input.jumpHostId);
      await checkHost(ctx, input.host, policy);
      try {
        return await db.transaction().execute(async (tx) => {
          const row = await tx
            .insertInto('targets')
            .values({
              id: uuidv7(),
              name: input.name,
              description: input.description ?? null,
              host: input.host.toLowerCase(),
              port: input.port,
              os: input.os,
              principal_template: input.principalTemplate,
              remote_root: input.remoteRoot,
              credential_ref_id: input.credentialRefId ?? null,
              policy_id: policy.id,
              jump_host_id: input.jumpHostId ?? null,
              tags: input.tags,
              status: 'pending_host_key',
              created_by: ctx.principal.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await audit(tx, ctx, {
            action: 'TARGET_CREATE',
            resourceType: 'target',
            resourceId: row.id,
            metadata: { name: row.name, host: row.host, policyId: row.policy_id },
          });
          return toTargetDto(row, []);
        });
      } catch (error) {
        throw isUniqueViolation(error)
          ? new DomainError('CONFLICT', 'a target with this name exists')
          : error;
      }
    },

    async updateTarget(ctx: RequestContext, id: string, input: UpdateTargetRequest) {
      const current = await targetOr404(id);
      const policy = await policyOr404(input.policyId ?? current.policy_id);
      const port = input.port ?? current.port;
      if (!policy.allowed_ports.includes(port)) {
        throw new DomainError('INVALID_REQUEST', 'the port is not allowed by the policy', {
          details: { field: 'port' },
        });
      }
      // A new policy may not allow the existing host's addresses.
      if (input.policyId !== undefined) await checkHost(ctx, current.host, policy);
      return db.transaction().execute(async (tx) => {
        let status = current.status;
        if (input.status === 'disabled') status = 'disabled';
        if (input.status === 'active') {
          const next = {
            ...current,
            credential_ref_id:
              input.credentialRefId === undefined ? current.credential_ref_id : input.credentialRefId,
          };
          if (!(await canActivate(next, tx))) {
            throw new DomainError(
              'CONFLICT',
              'a target needs a trusted host key and a credential to become active',
            );
          }
          status = 'active';
        }
        const row = await tx
          .updateTable('targets')
          .set({
            ...(input.description !== undefined && { description: input.description }),
            ...(input.port !== undefined && { port: input.port }),
            ...(input.principalTemplate !== undefined && { principal_template: input.principalTemplate }),
            ...(input.remoteRoot !== undefined && { remote_root: input.remoteRoot }),
            ...(input.policyId !== undefined && { policy_id: input.policyId }),
            ...(input.credentialRefId !== undefined && { credential_ref_id: input.credentialRefId }),
            ...(input.tags !== undefined && { tags: input.tags }),
            status,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, ctx, {
          action: 'TARGET_UPDATE',
          resourceType: 'target',
          resourceId: id,
          metadata: { name: row.name, fields: Object.keys(input).sort() },
        });
        return toTargetDto(
          row,
          await tx.selectFrom('target_host_keys').selectAll().where('target_id', '=', id).execute(),
        );
      });
    },

    async deleteTarget(ctx: RequestContext, id: string) {
      const t = await targetOr404(id);
      const inUse = await db
        .selectFrom('sessions')
        .select('id')
        .where('target_id', '=', id)
        .where('state', 'in', ['AUTHORIZED', 'CONNECTING', 'ACTIVE', 'CLOSING'])
        .executeTakeFirst();
      if (inUse !== undefined)
        throw new DomainError('CONFLICT', 'the target has open sessions; disable it first');
      await db.transaction().execute(async (tx) => {
        // Session history keeps the id; the target row goes (host keys cascade).
        await tx.updateTable('sessions').set({ target_id: null }).where('target_id', '=', id).execute();
        await tx.deleteFrom('targets').where('id', '=', id).execute();
        await audit(tx, ctx, {
          action: 'TARGET_DELETE',
          resourceType: 'target',
          resourceId: id,
          metadata: { name: t.name },
        });
      });
    },

    /** Approves a host key compared out of band; never trust-on-first-use (08 §6). */
    async addHostKey(ctx: RequestContext, targetId: string, input: AddHostKeyRequest) {
      await targetOr404(targetId);
      const key =
        'publicKey' in input
          ? parsePublicKey(input.publicKey)
          : { algorithm: input.algorithm, fingerprintSha256: input.fingerprintSha256, publicKey: '' };
      try {
        await db.transaction().execute(async (tx) => {
          await tx
            .insertInto('target_host_keys')
            .values({
              id: uuidv7(),
              target_id: targetId,
              algorithm: key.algorithm,
              fingerprint_sha256: key.fingerprintSha256,
              public_key: key.publicKey,
              status: 'trusted',
              approved_by: ctx.principal.userId,
              approved_at: new Date(),
            })
            .execute();
          await audit(tx, ctx, {
            action: 'TARGET_HOST_KEY_APPROVED',
            resourceType: 'target',
            resourceId: targetId,
            metadata: { algorithm: key.algorithm, fingerprintSha256: key.fingerprintSha256 },
          });
        });
      } catch (error) {
        throw isUniqueViolation(error)
          ? new DomainError('CONFLICT', 'this host key is already recorded')
          : error;
      }
      return this.getTarget(ctx, targetId);
    },

    /** Revokes a key; a target left without a trusted key stops being connectable. */
    async revokeHostKey(ctx: RequestContext, targetId: string, keyId: string) {
      await db.transaction().execute(async (tx) => {
        const key = await tx
          .updateTable('target_host_keys')
          .set({ status: 'revoked' })
          .where('id', '=', keyId)
          .where('target_id', '=', targetId)
          .returning('fingerprint_sha256')
          .executeTakeFirst();
        if (key === undefined) throw new DomainError('NOT_FOUND');
        const trusted = await tx
          .selectFrom('target_host_keys')
          .select('id')
          .where('target_id', '=', targetId)
          .where('status', '=', 'trusted')
          .executeTakeFirst();
        if (trusted === undefined) {
          await tx
            .updateTable('targets')
            .set({ status: 'pending_host_key', updated_at: new Date() })
            .where('id', '=', targetId)
            .where('status', '=', 'active')
            .execute();
        }
        await audit(tx, ctx, {
          action: 'TARGET_HOST_KEY_REVOKED',
          resourceType: 'target',
          resourceId: targetId,
          metadata: { fingerprintSha256: key.fingerprint_sha256 },
        });
      });
      return this.getTarget(ctx, targetId);
    },

    policyOr404,
    targetOr404,
  };
}
