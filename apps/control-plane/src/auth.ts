import { createHash, timingSafeEqual } from 'node:crypto';

import { DomainError } from '@qe/domain';
import { isRoutePermission, permissionsFor, type Permission, type RoutePermission } from '@qe/rbac';
import type { FastifyRequest } from 'fastify';

/** The authenticated caller, with the roles and permissions resolved for this request. */
export interface Principal {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string | undefined;
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
}

export const makePrincipal = (user: {
  userId: string;
  username: string;
  displayName?: string;
  email?: string | null;
  roles: readonly string[];
}): Principal => ({
  userId: user.userId,
  username: user.username,
  displayName: user.displayName ?? user.username,
  email: user.email ?? undefined,
  roles: [...user.roles].sort(),
  permissions: permissionsFor(user.roles),
});

export { isRoutePermission, type RoutePermission };

/** A signed-in browser session: who it is and the hash of its CSRF token. */
export interface ResolvedSession {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly csrfHash: Buffer;
}

/** What authentication looks at: cookies only (HTTP requests and WebSocket upgrades alike). */
export interface AuthInput {
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly requestId: string;
}

/** How a request proves who it is. Dev mode and OIDC sessions are the two implementations. */
export interface Authenticator {
  /** `undefined` when the request carries no (valid) credentials. */
  authenticate(input: AuthInput): Promise<Authenticated | undefined>;
  /** Called when an audited route is refused for lack of permission (best effort). */
  recordDenied?(request: FastifyRequest, principal: Principal, permission: Permission): Promise<void>;
}

export type Authenticated =
  | { readonly kind: 'dev'; readonly principal: Principal }
  | { readonly kind: 'session'; readonly session: ResolvedSession };

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required on every route (CLAUDE.md rule 7); checked when the route is registered. */
    permission?: RoutePermission;
    /** Whether the route emits audit events (and so audits its denials). */
    audit?: boolean;
    /**
     * `origin`: unsafe methods need an allowed Origin header instead of the CSRF token — for the workspace
     * router, whose IDE traffic cannot add our header. SameSite=Lax already keeps the cookie off cross-site POSTs.
     */
    csrf?: 'token' | 'origin';
  }
  interface FastifyRequest {
    principal?: Principal;
    webSession?: ResolvedSession;
  }
}

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time check of a presented CSRF token against the session's stored hash. */
export function csrfMatches(presented: unknown, expectedHash: Buffer): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 256) return false;
  const actual = sha256(presented);
  return actual.length === expectedHash.length && timingSafeEqual(actual, expectedHash);
}

/** Dev mode only (refused in production by config): every request acts as one seeded user. */
export const devAuthenticator = (principal: Principal): Authenticator => ({
  authenticate: () => Promise.resolve({ kind: 'dev', principal }),
});

/** No credentials are ever valid: the server answers 401 on every protected route (fail closed). */
export const noAuthenticator: Authenticator = { authenticate: () => Promise.resolve(undefined) };

/**
 * Authentication, CSRF and authorization for every route, in that order (Phase 04 §4.3–4.6). Runs in
 * `onRequest`, before the body is parsed or validated:
 *  - `public` routes skip everything; unknown paths need a signed-in user (no route enumeration);
 *  - otherwise a principal is required (401);
 *  - cookie sessions must send the session's CSRF token on unsafe methods (403 CSRF_REJECTED);
 *  - `authenticated` routes need nothing more; any other value is a permission the principal must hold
 *    (403 FORBIDDEN, audited for routes that audit).
 */
export function authorize(authenticator: Authenticator) {
  return async (request: FastifyRequest): Promise<void> => {
    const permission = request.is404 ? 'authenticated' : request.routeOptions.config.permission;
    if (permission === 'public') return;
    // Routes without a valid declaration never register (assertRouteDeclarations); be defensive anyway.
    if (permission === undefined || !isRoutePermission(permission)) throw new DomainError('FORBIDDEN');

    const result = await authenticator.authenticate({ cookies: request.cookies, requestId: request.id });
    if (result === undefined) throw new DomainError('AUTH_REQUIRED');
    const principal = result.kind === 'dev' ? result.principal : result.session.principal;
    request.principal = principal;

    if (result.kind === 'session') {
      request.webSession = result.session;
      if (
        !SAFE_METHODS.has(request.method) &&
        request.routeOptions.config.csrf !== 'origin' &&
        !csrfMatches(request.headers[CSRF_HEADER], result.session.csrfHash)
      ) {
        throw new DomainError('CSRF_REJECTED');
      }
    }

    if (permission === 'authenticated' || principal.permissions.has(permission)) return;
    if (request.routeOptions.config.audit === true && authenticator.recordDenied !== undefined) {
      try {
        await authenticator.recordDenied(request, principal, permission);
      } catch (error) {
        request.log.error({ err: error }, 'could not audit an access denial');
      }
    }
    throw new DomainError('FORBIDDEN');
  };
}

export function principalOf(request: FastifyRequest): Principal {
  if (request.principal === undefined) throw new DomainError('AUTH_REQUIRED');
  return request.principal;
}

/**
 * Origin allowlist for state-changing requests (05_API_CONTRACTS §1). A browser always sends Origin on
 * unsafe cross-origin requests, so a foreign Origin is refused before any handler runs.
 */
export function checkOrigin(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).origin));
  return async (request: FastifyRequest): Promise<void> => {
    const origin = request.headers.origin;
    if (SAFE_METHODS.has(request.method)) return;
    if (origin === undefined) {
      // Routes that rely on Origin instead of a CSRF token must receive one.
      if (request.routeOptions.config.csrf === 'origin') throw new DomainError('CSRF_REJECTED');
      return;
    }
    if (!allowed.has(origin)) throw new DomainError('CSRF_REJECTED');
    await Promise.resolve();
  };
}
