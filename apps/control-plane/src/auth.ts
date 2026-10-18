import { DomainError } from '@qe/domain';
import type { FastifyRequest } from 'fastify';

/** The authenticated caller. Roles and permissions arrive with Phase 04 (RBAC). */
export interface Principal {
  readonly userId: string;
  readonly username: string;
}

export const Permissions = [
  'workspace:read',
  'workspace:create',
  'workspace:write',
  'workspace:delete',
] as const;
export type Permission = (typeof Permissions)[number];
export type RoutePermission = Permission | 'public';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required on every route (CLAUDE.md rule 7); checked when the route is registered. */
    permission?: RoutePermission;
    /** Whether the route emits audit events. */
    audit?: boolean;
  }
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Authentication until Phase 04: in AUTH_MODE=dev every request acts as the seeded dev user; in oidc mode no
 * session mechanism exists yet, so every protected route answers 401 (fail closed).
 */
export function authenticate(devPrincipal: Principal | undefined) {
  return async (request: FastifyRequest): Promise<void> => {
    // Only routes that declare 'public' skip authentication; anything undeclared fails closed.
    if (request.routeOptions.config.permission === 'public') return;
    if (devPrincipal === undefined) throw new DomainError('AUTH_REQUIRED');
    request.principal = devPrincipal;
    await Promise.resolve();
  };
}

export function principalOf(request: FastifyRequest): Principal {
  if (request.principal === undefined) throw new DomainError('AUTH_REQUIRED');
  return request.principal;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Origin allowlist for state-changing requests (05_API_CONTRACTS §1). A browser always sends Origin on
 * unsafe cross-origin requests, so a foreign Origin is refused; the double-submit CSRF cookie joins this
 * with the session cookie in Phase 04.
 */
export function checkOrigin(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).origin));
  return async (request: FastifyRequest): Promise<void> => {
    const origin = request.headers.origin;
    if (SAFE_METHODS.has(request.method) || origin === undefined) return;
    if (!allowed.has(origin)) throw new DomainError('CSRF_REJECTED');
    await Promise.resolve();
  };
}
