# Phase 04 — Development Identity and RBAC Skeleton

| | |
|---|---|
| **Goal** | Every request has an authenticated principal; every route is authorized server-side from a permission matrix |
| **Duration** | 4–5 days |
| **Prerequisites** | Phase 03 |
| **Prompt pack** | `03_PROMPTS/PHASE_04_PROMPTS.md` |

> Build the **real** session/authz machinery now against a **dev OIDC provider** (Keycloak/dex in compose). Phase 12 swaps in the corporate IdP by configuration only.

## Deliverables
- OIDC login (code + PKCE), server-side sessions, CSRF protection, `/api/v1/me`.
- `packages/rbac`: permission list, role matrix, evaluator, resource-scope helpers.
- Authz `preHandler` enforcing `config.permission` on every route (fail closed if missing).
- Generated authorization-matrix tests.

## Step-by-step

### 4.1 Dev IdP
Keycloak realm `qe` exported to `deploy/compose/keycloak/realm-qe.json`; client `qe-workspace`; users `alice` (qe.user), `bob` (qe.user + lab.a.user), `admin` (qe.admin), `audrey` (auditor); `groups` claim.

### 4.2 OIDC flow (`openid-client`)
1. `/auth/login`: create `state`, `nonce`, `code_verifier` → short-lived signed HttpOnly cookie; `returnTo` must start with `/` and not `//`.
2. `/auth/callback`: verify state; exchange code; validate ID token (iss, aud, exp, nonce); upsert user by `(iss, sub)`; map groups → roles; create server-side session (32 random bytes, store hash only); set `qews_session` (HttpOnly, Secure, SameSite=Lax) and `qews_csrf`; audit `AUTH_LOGIN_SUCCESS`.
3. Idle (30 min) and absolute (8 h) timeouts checked on every request; `last_seen_at` updated ≤ 1/min.
4. `/auth/logout`: delete session, clear cookies, audit.

### 4.3 Principal
```ts
export interface Principal {
  userId: string; username: string; displayName: string;
  roles: readonly string[]; permissions: ReadonlySet<Permission>;
  authMethod: 'oidc-session' | 'bearer' | 'service';
}
```
Public allowlist: `/healthz`, `/readyz`, `/version`, `/auth/*`. Everything else → 401 without a principal.

### 4.4 RBAC package
```ts
export const Permissions = ['workspace:create','workspace:read','workspace:write','workspace:delete',
  'workspace:start','workspace:stop','workspace:admin','terminal:open','target:list','target:admin',
  'policy:admin','remote:connect','remote:file_read','remote:file_write','remote:execute',
  'port_forward:use','session:admin','qe_test:execute','qe_test:cancel','audit:read','audit:export',
  'platform:admin'] as const;
export type Permission = typeof Permissions[number];
export const RoleMatrix: Record<string, readonly Permission[]> = { /* see 07_SECURITY §4.2 */ };
```
- `requireWorkspaceRole(principal, wsId, 'viewer'|'editor'|'owner')`.
- Invisible resources return **404**, not 403.

### 4.5 Authorization preHandler
- Reads `routeOptions.config.permission`. A non-public route without one = **startup error**.
- Emits `qews.authz.decisions{permission,decision}`; audits denials of privileged actions.

### 4.6 CSRF & Origin
- Unsafe methods: `Origin` ∈ `ALLOWED_ORIGINS` **and** `x-csrf-token` == `qews_csrf` cookie.
- Bearer requests (desktop) skip CSRF but require correct token audience.

### 4.7 Frontend
- `client-sdk` adds the CSRF header; 401 → redirect to `/auth/login?returnTo=…`.
- `qe-core` status bar shows the user; "QE: Sign out" command.

## Tests
- Unit: evaluator, `returnTo` validation, timeouts.
- Integration: full OIDC login against a Keycloak container.
- **Authz matrix** (`tests/security/authz-matrix.test.ts`): all registered routes × test users → expected decision.
- CSRF negatives; IDOR: bob GETs alice's workspace → 404.

## Exit criteria
- [ ] Automated check: every non-public route declares a permission.
- [ ] Authz matrix green; prod config refuses `AUTH_MODE=dev`; login/logout audited.
