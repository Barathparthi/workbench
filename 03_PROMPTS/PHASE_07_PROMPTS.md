# Prompt Pack — Phase 07: Remote Target Registry & Policy

Phase guide: `02_PHASES/PHASE_07_REMOTE_TARGET_REGISTRY_AND_POLICY.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P07.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P07.1 … P07.6 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P07.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 07 — Remote Target Registry & Policy
Read docs/phases/PHASE_07_REMOTE_TARGET_REGISTRY_AND_POLICY.md (copy of the kit's phase guide) fully before anything else.
GOAL: Admin target/policy/host-key APIs, SSRF AddressGuard, pure policy evaluation, session + single-use ticket issuance, UI listing.
IN SCOPE: packages/policy; apps/control-plane targets/policies/sessions; extensions/qe-remote (list view); extensions/qe-admin
OUT OF SCOPE (do not touch): actual SSH connections (Phase 08)
ACCEPTANCE: SSRF + policy ≥95% branch coverage; tickets single-use; all decisions audited.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 07`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P07.1 — Schemas

```text
Add Zod schemas for targets, policies, host keys, credential refs and sessions per the API contract with the
validation rules in step 7.1 (host, port, remoteRoot, principalTemplate; no raw secrets accepted). Unit tests
with hostile inputs.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P07.2 — AddressGuard

```text
Implement AddressGuard with ipaddr.js: resolve all addresses, normalise mapped IPv6, deny list (loopback,
link-local, metadata, cluster CIDRs), allowed CIDRs; return the pinned IP. Exhaustive unit corpus including
odd IP encodings and mixed DNS answers (use an injectable resolver).

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P07.3 — Policy evaluator

```text
Implement evaluateConnection as a pure function per the guide with reason codes. Truth-table tests.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P07.4 — Admin APIs

```text
Implement targets/policies/host-keys CRUD (admin permissions), target activation rules, audit for every
change. Integration tests incl. SSRF denial at registration.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P07.5 — Sessions + tickets

```text
Implement POST /targets/{id}/sessions (authz, policy, rate limit, session row, ticket hash, 60 s TTL, origin
binding, audit) and internal ticket redeem (atomic single use, service-auth only). Concurrency test: 10
redeems → 1 success.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P07.6 — UI

```text
qe-remote Remote Connections tree (policy-filtered list, grouped by tag). qe-admin target form with SSRF
feedback and host-key approval dialog. Server remains the enforcement point.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run test:unit -w @qe/policy -- --coverage
npm run test:integration -w @qe/control-plane
npx vitest run tests/security/ssrf.test.ts
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: SSRF + policy ≥95% branch coverage; tickets single-use; all decisions audited.
