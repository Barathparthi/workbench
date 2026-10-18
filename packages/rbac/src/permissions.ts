/**
 * Every permission the platform knows (05_API_CONTRACTS §2, 07_SECURITY §4.2). Routes declare one of these,
 * `authenticated` (any signed-in user) or `public`; anything else is refused when the route is registered.
 */
export const Permissions = [
  'workspace:create',
  'workspace:read',
  'workspace:write',
  'workspace:delete',
  'workspace:start',
  'workspace:stop',
  'workspace:admin',
  'terminal:open',
  'target:list',
  'target:admin',
  'policy:admin',
  'remote:connect',
  'remote:file_read',
  'remote:file_write',
  'remote:execute',
  'port_forward:use',
  'session:admin',
  'qe_test:execute',
  'qe_test:cancel',
  'audit:read',
  'audit:export',
  'platform:admin',
] as const;

export type Permission = (typeof Permissions)[number];

/** What a route may declare: a permission, any signed-in user, or no authentication at all. */
export type RoutePermission = Permission | 'authenticated' | 'public';

const known = new Set<string>(Permissions);

export const isPermission = (value: string): value is Permission => known.has(value);

export const isRoutePermission = (value: string): value is RoutePermission =>
  value === 'authenticated' || value === 'public' || isPermission(value);
