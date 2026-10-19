import { z } from 'zod';

/**
 * Audit actions (06_DATA_MODEL §3) and, per action, the only metadata keys allowed. Metadata is an
 * allowlist, never free-form: no secrets, tokens, file contents, terminal bytes or command lines.
 * Actions without an entry here cannot be written yet; they are added with the feature that emits them.
 */
const short = z.string().max(200);

export const AuditMetadata = {
  // Phase 04 — authentication and authorization. Roles are names only, never tokens or claims.
  AUTH_LOGIN_SUCCESS: z.strictObject({
    method: z.literal('oidc'),
    roles: z.array(short).max(50),
  }),
  AUTH_LOGIN_FAILURE: z.strictObject({
    reason: z.enum([
      'invalid_transaction',
      'idp_error',
      'token_exchange',
      'invalid_claims',
      'user_disabled',
      'username_conflict',
    ]),
  }),
  AUTH_LOGOUT: z.strictObject({}),
  AUTH_SESSION_EXPIRED: z.strictObject({ reason: z.enum(['idle', 'absolute', 'user_disabled']) }),
  ACCESS_DENIED: z.strictObject({ permission: short, method: short, route: short }),
  // Phase 07 — targets, policies, credentials (names and ids only; never secret material).
  TARGET_CREATE: z.strictObject({ name: short, host: short, policyId: z.uuid() }),
  TARGET_UPDATE: z.strictObject({ name: short, fields: z.array(short).max(20) }),
  TARGET_DELETE: z.strictObject({ name: short }),
  TARGET_HOST_KEY_APPROVED: z.strictObject({ algorithm: short, fingerprintSha256: short }),
  TARGET_HOST_KEY_REVOKED: z.strictObject({ fingerprintSha256: short }),
  POLICY_CREATE: z.strictObject({ name: short }),
  POLICY_UPDATE: z.strictObject({ name: short, version: z.number().int() }),
  CREDENTIAL_REF_CREATE: z.strictObject({ provider: short, method: short }),
  SSRF_BLOCKED: z.strictObject({ host: short, reason: short }),
  REMOTE_CONNECT_ALLOWED: z.strictObject({
    targetId: z.uuid(),
    kind: short,
    policyVersion: z.number().int(),
  }),
  REMOTE_CONNECT_DENIED: z.strictObject({ targetId: z.uuid(), kind: short, reason: short }),
  REMOTE_SESSION_CLOSED: z.strictObject({ reason: short }),
  WORKSPACE_CREATE: z.strictObject({ name: short, templateId: short }),
  WORKSPACE_DELETE: z.strictObject({ name: short }),
  // Phase 05 — runtime lifecycle. `reason` says who or what stopped it; failures carry a short code.
  WORKSPACE_START: z.strictObject({ name: short, profile: short }),
  WORKSPACE_STOP: z.strictObject({
    name: short,
    reason: z.enum(['user', 'idle', 'runtime_lost', 'start_failed', 'stuck_stopping']),
  }),
  WORKSPACE_MEMBER_CHANGE: z.strictObject({
    memberId: z.uuid(),
    role: z.enum(['owner', 'editor', 'viewer', 'removed']),
  }),
} as const;

export type AuditAction = keyof typeof AuditMetadata;
export const AuditActions = Object.keys(AuditMetadata) as AuditAction[];

export const AuditResults = ['success', 'denied', 'failure'] as const;
export type AuditResult = (typeof AuditResults)[number];

export const AuditActorTypes = ['user', 'service', 'system'] as const;
export type AuditActorType = (typeof AuditActorTypes)[number];
