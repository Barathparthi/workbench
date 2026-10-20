/** What a remote session is for (05_API_CONTRACTS §2.4). */
export const SessionKinds = ['terminal', 'files', 'exec'] as const;
export type SessionKind = (typeof SessionKinds)[number];

/** Per-policy capabilities (08_REMOTE_CONNECTIVITY §2). Port forwarding stays off unless a policy names it. */
export const Capabilities = ['terminal', 'file_read', 'file_write', 'exec', 'port_forward'] as const;
export type Capability = (typeof Capabilities)[number];

/** The permission and capability each session kind needs. */
export const KIND_REQUIREMENTS: Readonly<
  Record<SessionKind, { permission: string; capability: Capability }>
> = {
  terminal: { permission: 'remote:connect', capability: 'terminal' },
  files: { permission: 'remote:file_read', capability: 'file_read' },
  exec: { permission: 'remote:execute', capability: 'exec' },
};

export interface PolicyView {
  readonly allowedRoles: readonly string[];
  readonly capabilities: readonly string[];
  readonly maxSessionsPerUser: number;
  readonly idleTimeoutSec: number;
  readonly maxSessionSec: number;
  readonly version: number;
}

export interface CallerView {
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<string>;
}

export type DenyReason =
  'target_inactive' | 'missing_permission' | 'role_not_allowed' | 'capability_not_allowed' | 'session_limit';

export type ConnectionDecision =
  | {
      readonly allowed: true;
      readonly policyVersion: number;
      readonly idleTimeoutSec: number;
      readonly maxSessionSec: number;
    }
  | {
      readonly allowed: false;
      /** `FORBIDDEN` for a missing permission, `QUOTA_EXCEEDED` for the session limit, else `TARGET_NOT_ALLOWED`. */
      readonly code: 'FORBIDDEN' | 'TARGET_NOT_ALLOWED' | 'QUOTA_EXCEEDED';
      readonly reason: DenyReason;
    };

/**
 * May this caller open this kind of session to this target now? (Phase 07 §7.3.) Pure and total: every input
 * leads to an explicit decision with a reason code for the audit trail. Runs before any network activity.
 */
export function evaluateConnection(
  caller: CallerView,
  target: { readonly status: string },
  policy: PolicyView,
  kind: SessionKind,
  activeSessions: number,
): ConnectionDecision {
  if (target.status !== 'active')
    return { allowed: false, code: 'TARGET_NOT_ALLOWED', reason: 'target_inactive' };
  const need = KIND_REQUIREMENTS[kind];
  if (!caller.permissions.has(need.permission)) {
    return { allowed: false, code: 'FORBIDDEN', reason: 'missing_permission' };
  }
  if (!policy.allowedRoles.some((r) => caller.roles.includes(r))) {
    return { allowed: false, code: 'TARGET_NOT_ALLOWED', reason: 'role_not_allowed' };
  }
  if (!policy.capabilities.includes(need.capability)) {
    return { allowed: false, code: 'TARGET_NOT_ALLOWED', reason: 'capability_not_allowed' };
  }
  if (activeSessions >= policy.maxSessionsPerUser) {
    return { allowed: false, code: 'QUOTA_EXCEEDED', reason: 'session_limit' };
  }
  return {
    allowed: true,
    policyVersion: policy.version,
    idleTimeoutSec: policy.idleTimeoutSec,
    maxSessionSec: policy.maxSessionSec,
  };
}

/** Whether a role may see a target at all (list filtering): its policy names one of the caller's roles. */
export const canSeeTarget = (
  caller: Pick<CallerView, 'roles'>,
  policy: Pick<PolicyView, 'allowedRoles'>,
): boolean => policy.allowedRoles.some((r) => caller.roles.includes(r));
