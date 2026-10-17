# Prompt Pack — Phase 19: Optional Advanced Remote

Phase guide: `02_PHASES/PHASE_19_OPTIONAL_ADVANCED_REMOTE.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P19.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P19.1 … P19.3 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P19.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 19 — Optional Advanced Remote
Read docs/phases/PHASE_19_OPTIONAL_ADVANCED_REMOTE.md (copy of the kit's phase guide) fully before anything else.
GOAL: Post-GA: remote agent mode, governed port forwarding, zone brokers, step-up auth, session recording.
IN SCOPE: one feature per branch
OUT OF SCOPE (do not touch): anything without its own ADR and threat-model addendum
ACCEPTANCE: Feature shipped OFF by default with ADR, threat addendum, tests and docs.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 19`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P19.1 — Design first

```text
For feature <19.x>, write an ADR and a threat-model addendum (new assets, boundaries, threats, controls,
tests). Do not write code.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P19.2 — Implement behind policy capability

```text
Implement <19.x> behind a policy capability defaulting to OFF, with audit events, metrics and negative tests
for every new threat.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P19.3 — Parity + docs

```text
Ensure the feature behaves identically in hosted/local-web/desktop where applicable; update parity suite and
docs.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npx vitest run tests/security
npx playwright test tests/parity
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Feature shipped OFF by default with ADR, threat addendum, tests and docs.
