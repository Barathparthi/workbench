import { z } from 'zod';

/**
 * Audit actions (06_DATA_MODEL §3) and, per action, the only metadata keys allowed. Metadata is an
 * allowlist, never free-form: no secrets, tokens, file contents, terminal bytes or command lines.
 * Actions without an entry here cannot be written yet; they are added with the feature that emits them.
 */
const short = z.string().max(200);
const remotePath = z.string().max(4096);

export const AuditMetadata = {
  // Phase 04 — authentication and authorization. Roles are names only, never tokens or claims.
  AUTH_LOGIN_SUCCESS: z.strictObject({
    // desktop_token: the first request of a desktop sign-in (an IdP session) carrying a bearer access token.
    method: z.enum(['oidc', 'desktop_token']),
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
  // Phase 08 — reported by the broker. Byte counts only; never terminal content.
  SSH_SESSION_OPENED: z.strictObject({ brokerInstance: short, fingerprintSha256: short }),
  SSH_SESSION_CLOSED: z.strictObject({
    reason: short,
    bytesIn: z.number().int(),
    bytesOut: z.number().int(),
    durationSec: z.number().int(),
  }),
  SSH_CONNECT_FAILED: z.strictObject({ reason: short }),
  SSH_HOST_KEY_MISMATCH: z.strictObject({ algorithm: short, presentedFingerprint: short }),
  SSH_HOST_KEY_UNKNOWN: z.strictObject({ algorithm: short, presentedFingerprint: short }),
  // Phase 09 — remote file changes. Paths are relative to the target's remoteRoot; never file contents.
  REMOTE_FILE_WRITE: z.strictObject({
    targetId: z.uuid(),
    op: z.enum(['write', 'mkdir']),
    path: remotePath,
    size: z.number().int().min(0).optional(),
  }),
  REMOTE_FILE_DELETE: z.strictObject({ targetId: z.uuid(), path: remotePath, recursive: z.boolean() }),
  REMOTE_FILE_RENAME: z.strictObject({ targetId: z.uuid(), from: remotePath, to: remotePath }),
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
  // Phase 11 — QE runner. The selector's kind only: no paths, test names or command lines.
  QE_TEST_STARTED: z.strictObject({
    workspaceId: z.uuid(),
    targetId: z.uuid().optional(),
    framework: short,
    selectorKind: z.enum(['all', 'file', 'node', 'marker']),
  }),
  QE_TEST_FINISHED: z.strictObject({
    state: z.enum(['PASSED', 'FAILED', 'ERROR']),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().min(0),
    total: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    errors: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }),
  QE_TEST_CANCELLED: z.strictObject({ durationMs: z.number().int().min(0) }),
} as const;

export type AuditAction = keyof typeof AuditMetadata;
export const AuditActions = Object.keys(AuditMetadata) as AuditAction[];

export const AuditResults = ['success', 'denied', 'failure'] as const;
export type AuditResult = (typeof AuditResults)[number];

export const AuditActorTypes = ['user', 'service', 'system'] as const;
export type AuditActorType = (typeof AuditActorTypes)[number];
