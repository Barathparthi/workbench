import { isPermission, Permissions, type Permission } from './permissions.js';

/**
 * The role → permission matrix (07_SECURITY §4.2). Data, reviewed by security; change it only with a
 * matrix-test update. Target-level grants (which lab a user may reach) come from connection policies in
 * Phase 07 — the `lab.<name>.user` roles here only grant the ability to use remote features at all.
 */
const QE_USER: readonly Permission[] = [
  'workspace:create',
  'workspace:read',
  'workspace:write',
  'workspace:delete',
  'workspace:start',
  'workspace:stop',
  'terminal:open',
  'target:list',
  'qe_test:execute',
  'qe_test:cancel',
];

const LAB_USER: readonly Permission[] = ['target:list', 'remote:connect', 'remote:file_read'];

// The admin runs the platform but does not get audit export or port forwarding by default:
// export is the auditor's job, forwarding is policy-granted (Phase 19).
const QE_ADMIN: readonly Permission[] = Permissions.filter(
  (p) => p !== 'audit:export' && p !== 'port_forward:use',
);

export const RoleMatrix: Readonly<Record<string, readonly Permission[]>> = {
  'qe.user': QE_USER,
  'qe.lead': [...QE_USER, 'workspace:admin'],
  'qe.admin': QE_ADMIN,
  auditor: ['audit:read', 'audit:export'],
};

/** `lab.<name>.user`, with a lowercase name of letters, digits and dashes. */
const LAB_ROLE = /^lab\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.user$/;

export const isLabRole = (role: string): boolean => LAB_ROLE.test(role);

/** Whether the role name is one the matrix grants anything to. Unknown roles grant nothing. */
export const isKnownRole = (role: string): boolean => Object.hasOwn(RoleMatrix, role) || isLabRole(role);

/** The union of the permissions of the given roles. Unknown roles contribute nothing (fail closed). */
export function permissionsFor(roles: Iterable<string>): ReadonlySet<Permission> {
  const result = new Set<Permission>();
  for (const role of roles) {
    const granted = Object.hasOwn(RoleMatrix, role) ? RoleMatrix[role] : isLabRole(role) ? LAB_USER : [];
    for (const p of granted ?? []) result.add(p);
  }
  return result;
}

export function hasPermission(granted: ReadonlySet<Permission>, required: string): boolean {
  return isPermission(required) && granted.has(required);
}
