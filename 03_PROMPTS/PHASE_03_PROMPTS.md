# Prompt Pack — Phase 03: Control Plane & Database

Phase guide: `02_PHASES/PHASE_03_CONTROL_PLANE_AND_DATABASE.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P03.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P03.1 … P03.6 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P03.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 03 — Control Plane & Database
Read docs/phases/PHASE_03_CONTROL_PLANE_AND_DATABASE.md (copy of the kit's phase guide) fully before anything else.
GOAL: Fastify control plane with config validation, health, errors, logging, PostgreSQL migrations, repositories, audit writer and workspace metadata CRUD.
IN SCOPE: apps/control-plane; packages/contracts; migrations/; deploy/compose/
OUT OF SCOPE (do not touch): auth (Phase 04); runtime lifecycle (Phase 05)
ACCEPTANCE: /readyz 200 against compose PG; integration suite green; no stack traces in responses; redaction canary passes.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 03`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P03.1 — Config + server

```text
Implement config.ts (Zod, prod forbids AUTH_MODE=dev) and buildServer() with helmet, cookie, rate-limit, zod
type provider, request-ID handling, pino redaction, 1 MiB body limit, problem+json error handler. Unit-test
config and error mapping.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P03.2 — Health + shutdown

```text
Add /healthz, /readyz (DB ping + migration version), /version and SIGTERM graceful shutdown that flips
readiness first. Tests with app.inject.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P03.3 — Migrations

```text
Add migration tooling and 0001_init.sql from docs/architecture/06_DATA_MODEL.md and 0002_seed_templates.sql.
Create separate migrator and app DB roles; app role has no UPDATE/DELETE on audit_events. Integration test:
migrate from empty.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P03.4 — Repositories

```text
Implement Kysely repositories for users, workspaces (with CAS transition), members, templates. Integration
test: 20 concurrent transitions → exactly one winner.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P03.5 — Audit writer

```text
Implement AuditWriter with per-action metadata allowlist and hash chain under an advisory lock; verifier
function. Tests: chain verifies; tampering detected; app role cannot UPDATE.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P03.6 — Workspace CRUD + OpenAPI

```text
Implement workspace metadata endpoints and template listing using the route-declaration pattern
(permission/audit/rateLimit config). Generate OpenAPI and add openapi:check (oasdiff) script. Lifecycle
endpoints return 501.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
docker compose -f deploy/compose/docker-compose.dev.yml up -d postgres
npm run test:unit -w @qe/control-plane
npm run test:integration -w @qe/control-plane
npm run openapi:generate
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: /readyz 200 against compose PG; integration suite green; no stack traces in responses; redaction canary passes.
