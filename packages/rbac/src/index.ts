/**
 * @qe/rbac — Permission matrix and evaluator. Every route declares a permission; authorization is
 * server-side (05_API_CONTRACTS §2, 07_SECURITY_ARCHITECTURE_AND_THREAT_MODEL §4.2).
 */
export const PACKAGE_NAME = '@qe/rbac';

export {
  Permissions,
  isPermission,
  isRoutePermission,
  type Permission,
  type RoutePermission,
} from './permissions.js';
export { RoleMatrix, hasPermission, isKnownRole, isLabRole, permissionsFor } from './matrix.js';
export { RoleMappings, parseRoleMappings, rolesForGroups } from './role-mapping.js';
export { WorkspaceRoles, hasWorkspaceRole, isWorkspaceRole, type WorkspaceRole } from './workspace-roles.js';
