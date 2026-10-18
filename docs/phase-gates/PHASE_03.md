# Phase Gate — Phase 03: Control Plane and Database

**Date:** 2026-10-18 · **Branch/PRs:** `claude/gallant-goldberg-v788zv` → [PR #7](https://github.com/Barathparthi/workbench/pull/7) · **Reviewers:** @Barathparthi
(database decision 2026-10-18: one self-hosted PostgreSQL, no Supabase — D4)

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_03_CONTROL_PLANE_AND_DATABASE.md`.
Contracts: `01_ARCHITECTURE/05_API_CONTRACTS.md`, `06_DATA_MODEL.md`, `03_DETAILED_ARCHITECTURE.md` §3.

## Deliverables

| Deliverable                                                                                                                                      | Status                                                                                                                                                                         | Evidence                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `apps/control-plane` (Fastify 5): config validation, `/healthz` `/readyz` `/version`, problem+json, request IDs, redacting logger, graceful stop | done — exit 78 on bad config; readiness checks the database and the migration version; SIGTERM flips readiness, drains, closes the pool                                        | `apps/control-plane/src`, `server.test.ts`, `shutdown.test.ts`, `config.test.ts` |
| `packages/contracts`: Zod v1 DTOs + OpenAPI generation                                                                                           | done — workspaces, templates, problem details, audit metadata allowlist; `openapi.json` generated from the routes and checked for drift                                        | `packages/contracts/src`, `apps/control-plane/openapi.json`, `openapi.test.ts`   |
| Migrations `0001_init.sql` + runner                                                                                                              | done — full 06 §2 schema, `0002` seeds two templates; ordered, checksummed, one transaction each, advisory lock, refuses edited migrations                                     | `apps/control-plane/migrations`, `src/db/migrator.ts`                            |
| Kysely repositories: users, workspaces, members, templates, audit (insert-only)                                                                  | done — compare-and-set state transitions; membership-scoped reads; audit events hash-chained                                                                                   | `src/repos`, `src/audit`                                                         |
| `deploy/compose/docker-compose.dev.yml` with PostgreSQL                                                                                          | done — PostgreSQL 18.6 by digest, loopback only, application login role created on first start                                                                                 | `deploy/compose/`, `apps/control-plane/.env.example`                             |
| Integration tests with Testcontainers                                                                                                            | done — 23 tests: migrations, roles and grants, repositories, 20-way race, audit chain + tamper detection, append-only, idle-connection loss, API end to end, fail-closed audit | `src/__tests__/*.int.test.ts`; CI job `integration + coverage`                   |

## Exit criteria

| Criterion                                                                          | Result                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up postgres` + `npm run dev -w @qe/control-plane` → `/readyz` 200  | Met — on a fresh volume (`down -v`), output below; `dev` applies migrations first as the migrator role                                                                                               |
| Integration suite green in CI; no stack traces in responses; redaction test passes | Met locally (23/23 against PostgreSQL 18.6); the CI job runs on the PR. 500 responses carry only code + request id (`server.test.ts`); the redaction canary checks authorization, cookie and secrets |

## Validation (real output, trimmed)

Local (this container, Node 24.22.0, Docker 29.8.2, PostgreSQL 18.6):

```text
$ npm run verify
All matched files use Prettier code style!
 Test Files  31 passed (31)
      Tests  448 passed (448)
[build/browser] Finished with 0 errors …

$ npx vitest run --coverage            # unit + integration, as the CI job runs it
 Test Files  33 passed (33)
      Tests  471 passed (471)
Statements 85.95 % · Branches 85.55 % · Functions 85.91 % · Lines 86.82 %   (thresholds met; exit 0)

$ docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait postgres
 Container qews-dev-postgres-1 Healthy
$ npm run dev -w @qe/control-plane
migrations: applied 0001_init, 0002_seed_templates
GET /readyz -> 200 {"status":"ready"}
GET /version -> {"version":"0.0.0-dev","commit":"unknown","builtAt":"unknown"}
POST /api/v1/workspaces with Origin https://evil.example -> 403
SIGTERM -> {"msg":"shutting down"} … exit 0 in 14 ms

$ psql -U qews_app_login -c "delete from audit_events"
ERROR:  permission denied for table audit_events
```

## Security review

- **Threats touched**: T17 secret leakage (pino redaction of authorization/cookie/CSRF headers and secret-named
  fields, canary test; config errors name the variable, never the value; pg's idle-connection errors carry the
  client with its password, so only code and message are logged), T10 audit tampering (append-only by grants and
  by trigger even for the table owner, SHA-256 hash chain under an advisory lock, tamper detection test), T13 IDOR
  (every read joins membership; non-members get 404 on read, update and delete), CSRF (Origin allowlist on unsafe
  methods now; double-submit cookie with Phase 04 sessions).
- **Controls added**: every route must declare `permission`, `audit` and `rateLimit` or registration throws;
  authentication fails closed (OIDC mode answers 401 until Phase 04; undeclared paths are not public); `AUTH_MODE=dev`
  refused in production; per-route rate limits; helmet headers; 1 MiB body limit; `trustProxy` off; loopback bind
  by default; statement and idle-in-transaction timeouts on every connection; application role has DML only.
- **Negative tests**: invalid config (production + dev auth, bad URLs), schema violations without echoing input,
  oversized body, bad JSON, unknown route, 429, undeclared route, foreign and `null` Origin, credentials in a Git
  URL, stranger access (404), editor delete (403), deleting a running workspace (409), duplicate name (409),
  unknown template (400), audit metadata outside the allowlist, audit write failure rolls the action back, edited
  migration refused, failing migration rolled back, application role cannot DDL/UPDATE/DELETE/TRUNCATE audit or
  touch `schema_migrations`.
- **Self-review findings fixed in this phase**: an unhandled pool `error` event would have crashed the process on
  any PostgreSQL restart (found by the coverage run; now handled, with a test that terminates an idle backend);
  `ALLOWED_ORIGINS` was parsed but unused (now enforced); routes without a permission skipped authentication
  (now only `public` does).

## Operational review

- Metrics / spans: none yet (Phase 13). Logs: JSON (pino) with request id on every line and in `x-request-id`;
  5xx detail is logged server-side only.
- Audit events: `WORKSPACE_CREATE` and `WORKSPACE_DELETE`, written in the same transaction as the change; the
  action fails if the event cannot be written.
- Health: `/healthz` (process), `/readyz` (database answers within 1 s and migrations match the bundle; 503 while
  shutting down), `/version`. Exit code 78 on bad configuration.
- Alerts & runbooks: none yet; database backups and hosting for the single PostgreSQL are Phase 16 (D4).

## Parity (browser / local web / desktop)

- Not affected: the IDE does not call the control plane yet. Hosted mode uses it from Phase 05; local web and
  desktop run without it.

## Deviations from the guide (recorded)

- Name uniqueness is a partial unique index `WHERE state <> 'DELETED'`, so a deleted workspace frees its name
  (06 §2 has a plain `UNIQUE (owner_id, name)`).
- `audit_events` gains a `seq` identity column to order the hash chain and append-only triggers.
- Start/stop are not registered (the guide suggests 501 stubs); they arrive with runtimes in Phase 05 and the
  OpenAPI file shows only what works.
- No `WORKSPACE_UPDATE` audit action: renames are not privileged actions in 05 §5; membership changes are.
- Authentication: a seeded dev principal in `AUTH_MODE=dev` (development and tests only); OIDC is Phase 04.

## Known limitations & follow-ups

- Phase 04: OIDC login, sessions, double-submit CSRF, RBAC roles in place of the owner/editor checks.
- Phase 05: start/stop and workspace events; runtime providers.
- Phase 16 (D4): hosting, backups and a separate migrator login for the single production database.
- An OpenAPI breaking-change check (oasdiff) in CI is not added; the drift test covers accidental changes.

## Decision

- [x] **PASS** — confirmed 2026-10-18: @Barathparthi merged PR #7 with all five checks green (`verify` on
      ubuntu and windows, `integration + coverage`, `runtime image`, `smoke (browser + Electron)`).
- [ ] CONDITIONAL
- [ ] FAIL
