# Prompt Pack — Phase 04: Dev Identity & RBAC

Phase guide: `02_PHASES/PHASE_04_DEV_IDENTITY_AND_RBAC.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P04.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P04.1 … P04.7 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P04.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 04 — Dev Identity & RBAC
Read docs/phases/PHASE_04_DEV_IDENTITY_AND_RBAC.md (copy of the kit's phase guide) fully before anything else.
GOAL: OIDC login against a dev IdP, server-side sessions, CSRF, RBAC matrix and fail-closed authz on every route.
IN SCOPE: apps/control-plane auth; packages/rbac; deploy/compose/keycloak; client-sdk; qe-core status bar
OUT OF SCOPE (do not touch): corporate IdP specifics (Phase 12)
ACCEPTANCE: All non-public routes authenticated and permissioned; matrix green; prod refuses dev auth.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 04`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P04.1 — Dev IdP

```text
Add Keycloak (or dex) to compose with an exported realm (users alice, bob, admin, audrey; groups claim).
Document credentials as dev-only in the compose README.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P04.2 — OIDC flow

```text
Implement /auth/login, /auth/callback, /auth/logout with openid-client (code+PKCE, state, nonce), safe
returnTo, user upsert by (iss,sub), group→role mapping config, server-side session store with idle/absolute
timeouts, cookie flags, audit events. Integration test against the Keycloak container.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P04.3 — RBAC package

```text
Implement packages/rbac Permissions, RoleMatrix (from the security doc), evaluator and requireWorkspaceRole.
Table-driven tests.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P04.4 — Authz enforcement

```text
Add authenticate + authorize hooks: public allowlist, every other route must declare config.permission
(startup error otherwise), 404 for invisible resources, metrics and denial audit. Test that iterates all
routes.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P04.5 — CSRF + Origin

```text
Enforce Origin allowlist and double-submit CSRF on unsafe methods; bearer requests require audience. Negative
tests.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P04.6 — Authz matrix tests

```text
Create tests/security/authz-matrix.test.ts generating allow/deny cases for every route × test user from the
matrix, including IDOR cases.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P04.7 — Frontend wiring

```text
client-sdk: CSRF header, 401 → login redirect. qe-core: show user in status bar, sign-out command.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run test:unit
npm run test:integration -w @qe/control-plane
npx vitest run tests/security/authz-matrix.test.ts
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: All non-public routes authenticated and permissioned; matrix green; prod refuses dev auth.
