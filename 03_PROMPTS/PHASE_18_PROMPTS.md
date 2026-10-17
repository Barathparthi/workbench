# Prompt Pack — Phase 18: Pilot, Release & Rollout

Phase guide: `02_PHASES/PHASE_18_PILOT_RELEASE_ROLLOUT.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P18.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P18.1 … P18.4 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P18.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 18 — Pilot, Release & Rollout
Read docs/phases/PHASE_18_PILOT_RELEASE_ROLLOUT.md (copy of the kit's phase guide) fully before anything else.
GOAL: Release candidate, pilot with real QE engineers, telemetry-driven fixes, GA go/no-go, rollout waves.
IN SCOPE: docs/user; docs/admin; release notes; readiness checklist evidence
OUT OF SCOPE (do not touch): large new features
ACCEPTANCE: Milestone M5 — GA approved; final acceptance criteria all evidenced.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 18`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P18.1 — Readiness audit

```text
Walk docs/…/PRODUCTION_READINESS_CHECKLIST.md item by item; for each, link evidence in the repo or mark
missing with an owner. Do not tick items without evidence.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P18.2 — User & admin docs

```text
Finalise user guide (web, desktop, remote connections, runner) and admin guide (targets, policies, host keys,
revocation, audit) from implemented behaviour only.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P18.3 — Pilot analytics

```text
Given pilot telemetry and feedback <paste>, produce a weekly report: SLOs, top errors, friction themes,
prioritised fix list.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P18.4 — Go/No-Go pack

```text
Assemble the GA decision pack: SLO evidence, open issues by severity, security sign-off, support readiness,
capacity plan, rollout waves and comms.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
(evidence collection — no new commands)
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Milestone M5 — GA approved; final acceptance criteria all evidenced.
