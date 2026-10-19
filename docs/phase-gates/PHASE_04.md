# Phase Gate — Phase 04: Development Identity and RBAC

**Date:** 2026-10-18 · **Branch/PRs:** `phase-04-identity-rbac` → PR (to open) · **Reviewers:** @Barathparthi

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_04_DEV_IDENTITY_AND_RBAC.md`.
Contracts: `01_ARCHITECTURE/05_API_CONTRACTS.md` §1–2.1, `07_SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md` §4.1–4.2.

## Deliverables

| Deliverable                                                                            | Status                                                                                                                                                                                                                              | Evidence                                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| OIDC login (code + PKCE S256, state, nonce) against a dev IdP                          | done — `openid-client` 6.8.8 behind an `OidcProvider` interface; lazy, retried discovery; 10 s IdP timeout                                                                                                                          | `src/auth/oidc.ts`, `routes/auth.ts`, `oidc-keycloak.int.test.ts`                |
| Server-side sessions, idle (30 min) + absolute (8 h) timeouts                          | done — random 256-bit token in an HttpOnly cookie, only SHA-256 stored (`0003_web_sessions.sql`); expiry and disabled users end the session and are audited                                                                         | `src/auth/session-auth.ts`, `repos/web-sessions.ts`, `session-auth.int.test.ts`  |
| CSRF protection                                                                        | done — Origin allowlist (Phase 03) **and** a per-session CSRF token (hash stored with the session) required on unsafe methods; checked before permissions                                                                           | `src/auth.ts`, `auth.test.ts`                                                    |
| `/api/v1/me`                                                                           | done                                                                                                                                                                                                                                | `routes/auth.ts`, `auth-routes.test.ts`                                          |
| `@qe/rbac`: permissions, role matrix, evaluator, group → role mapping, workspace roles | done — 22 permissions; `qe.user`, `qe.lead`, `qe.admin`, `auditor`, `lab.<name>.user`; unknown roles grant nothing; `ROLE_MAPPINGS` rejects unknown roles at startup                                                                | `packages/rbac/src`, 100+ table tests                                            |
| Authorization on every route (fail closed)                                             | done — runs in `onRequest` (before body parsing/validation); routes declare a permission, `authenticated` or `public`, else registration throws; unknown paths need a session; audited routes audit their denials (`ACCESS_DENIED`) | `src/auth.ts`, `server.ts`                                                       |
| Generated authz-matrix tests                                                           | done — every registered route × 6 personas + anonymous; new routes covered automatically                                                                                                                                            | `src/__tests__/authz-matrix.test.ts`                                             |
| Dev IdP in compose                                                                     | done — Keycloak 26.8.1 by digest, realm `qe` (alice, bob, admin, audrey; groups claim)                                                                                                                                              | `deploy/compose/docker-compose.dev.yml`, `deploy/compose/keycloak/realm-qe.json` |
| Frontend wiring                                                                        | partial — `@qe/client-sdk` `ControlPlaneClient` (credentials, CSRF echo, 401 → login URL, problem+json errors); status-bar user display deferred to Phase 05 (the IDE reaches the control plane only through the workspace router)  | `packages/client-sdk/src`                                                        |

## Validation (real output, trimmed)

Local machine: Windows 11, Node 24.22.0, **no Docker** (owner decision: unit tests here, Docker-based tests in CI);
`npm install --ignore-scripts` (no Visual Studio Build Tools, so Theia's native modules are not compiled locally).

```text
$ npm run typecheck            → tsc -b tsconfig.build.json (exit 0)
$ npm run lint                 → 0 problems
$ npm run format:check         → All matched files use Prettier code style!
$ npx vitest run --project unit
 Test Files  34 passed (34)
      Tests  639 passed (639)
$ npm run openapi:generate -w @qe/control-plane → openapi: wrote openapi.json (auth routes + /api/v1/me added)
```

Not run locally (need Docker): `session-auth.int.test.ts`, `oidc-keycloak.int.test.ts`, the updated
`db.int.test.ts`/`api.int.test.ts`. They run in the CI job `integration + coverage`; record the result here.

## Security review

- **Threats touched**: T1 session theft (HttpOnly/Secure/SameSite=Lax cookie, server-side store, hash-only, idle +
  absolute expiry, logout deletes), T2 CSRF (Origin allowlist + session-bound token, constant-time compare), T3
  IDOR (404 for invisible workspaces; matrix test), T4 role escalation (roles only from configured group mappings to
  known roles; IdP cannot mint roles; manual roles kept separately), T21 open redirect (`safeReturnTo`, appended to
  `PUBLIC_ORIGIN`), T23 offboarding (disabled user → sessions refused and deleted on next request, login refused).
- **Controls added**: OIDC transaction in a signed, HttpOnly, `/auth`-scoped, 10-minute cookie; PKCE S256; nonce and
  state checked by `openid-client`; usernames restricted to `[a-z0-9][a-z0-9._-]{0,63}` (later SSH principals);
  username takeover by a different subject refused (`username_conflict`); production requires https issuer/redirect
  /origin and secure cookies; dev auth and plain-http IdP refused in production; auth endpoints rate limited 20/min.
- **Negative tests**: no/forged/expired session, wrong/empty/oversized CSRF token, CSRF checked before permission,
  forged transaction cookie, IdP error, failed exchange, replayed authorization code (Keycloak), wrong password,
  disabled user, username conflict, every route × persona without the permission, hostile `returnTo` corpus,
  hostile usernames (`-oProxyCommand`, `a;rm`), unknown roles in configuration, secrets not echoed in config errors.

## Operational review

- Audit events: `AUTH_LOGIN_SUCCESS` (roles), `AUTH_LOGIN_FAILURE` (reason), `AUTH_LOGOUT`, `AUTH_SESSION_EXPIRED`
  (idle/absolute/user_disabled), `ACCESS_DENIED` (permission, method, route) — metadata allowlisted.
- Logs: login failures logged with reason only; no tokens, codes or claims.
- Session table swept every 15 minutes (expired rows are refused on use regardless).
- Metrics: none yet (Phase 13).

## Deviations from the guide (recorded)

- Authorization runs in `onRequest` (guide: `preHandler`) so unauthenticated callers never reach body parsing or
  validation, and get 401 rather than 400.
- Bearer tokens for the desktop app are not accepted yet — they arrive with desktop sign-in (Phase 10).
- Status-bar user display moved to Phase 05 (see Deliverables).
- The authz matrix lives in `apps/control-plane/src/__tests__/` (guide: `tests/security/`) because it builds the
  server from source; it is part of the `unit` project and runs on every PR.

## Known limitations & follow-ups

- Run the Docker-based integration suites in CI and paste the result above.
- Phase 12: corporate IdP by configuration, periodic revalidation against the IdP, session revocation API.
- Theia native modules need Visual Studio Build Tools on Windows to build the IDE locally (`docs/LOCAL_DEVELOPMENT.md`).

## Decision

- [x] PASS — 2026-10-19: CI `integration + coverage` (run on the Phase 05 branch, which contains Phase 04) passed
      `session-auth.int.test.ts` and `oidc-keycloak.int.test.ts` against PostgreSQL 18.6 and Keycloak 26.8.1;
      the only failures were Phase 05 files (see PHASE_05.md)
- [ ] CONDITIONAL
- [ ] FAIL
