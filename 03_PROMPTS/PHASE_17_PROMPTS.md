# Prompt Pack — Phase 17: Performance, Reliability & DR

Phase guide: `02_PHASES/PHASE_17_PERFORMANCE_RELIABILITY_DR.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P17.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P17.1 … P17.5 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P17.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 17 — Performance, Reliability & DR
Read docs/phases/PHASE_17_PERFORMANCE_RELIABILITY_DR.md (copy of the kit's phase guide) fully before anything else.
GOAL: Load, soak, chaos, backup/restore and rollback drills against staging with evidence.
IN SCOPE: tests/load; scripts/chaos; docs/phase-gates/PHASE_17.md
OUT OF SCOPE (do not touch): feature work
ACCEPTANCE: SLOs met or re-baselined; no leaks in soak; chaos and DR drills pass.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 17`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P17.1 — Load scripts

```text
Write k6 scripts terminal_ws.js, ssh_burst.js, api_mix.js and workspace_storm.sh per the guide with thresholds
matching SLOs. Dry-run locally at small scale.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P17.2 — Bottleneck analysis

```text
Given staging results <paste>, identify the first bottleneck with evidence from metrics/traces/profiles and
propose fixes ranked by impact.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P17.3 — Chaos scenarios

```text
Write scripted chaos scenarios (kill broker/runtime pod, PG failover, Vault outage, target network block,
rolling restart during terminals) with expected outcomes and automated assertions on states and audit.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P17.4 — DR drills

```text
Write and execute (with me) the PG PITR restore and PVC snapshot restore runbooks; capture RTO/RPO.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P17.5 — Report

```text
Produce the phase gate with graphs/numbers and SLO comparison.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
k6 run tests/load/terminal_ws.js
k6 run tests/load/ssh_burst.js
bash scripts/chaos/run-all.sh staging
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: SLOs met or re-baselined; no leaks in soak; chaos and DR drills pass.
