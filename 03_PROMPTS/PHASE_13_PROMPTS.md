# Prompt Pack — Phase 13: Observability

Phase guide: `02_PHASES/PHASE_13_OBSERVABILITY.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P13.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P13.1 … P13.4 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P13.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 13 — Observability
Read docs/phases/PHASE_13_OBSERVABILITY.md (copy of the kit's phase guide) fully before anything else.
GOAL: OpenTelemetry traces/metrics/log correlation across services, dashboards and alerts as code, runbooks.
IN SCOPE: packages/telemetry; all service entrypoints; deploy/observability
OUT OF SCOPE (do not touch): new product features
ACCEPTANCE: Failures diagnosable from telemetry alone (game day); every alert has a runbook.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 13`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P13.1 — Telemetry package

```text
Implement initTelemetry and getLogger (pino + trace correlation + redaction) and metric name constants with a
label allowlist helper. Unit tests: redaction canary, label rejection.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P13.2 — Instrument flows

```text
Add the spans from the observability doc §3 and metrics §4 in control plane, broker, runtime backend
contributions and runner. Never include bytes/content/secrets.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P13.3 — Collector + dashboards

```text
Add OTel collector config with memory_limiter, batch and a sensitive-attribute delete processor; dashboards
(6) and alert rules as code with runbook links.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P13.4 — Verification

```text
Integration test using the collector file exporter asserting the SSH connect trace shape and absence of
forbidden attributes. Draft runbooks for each alert.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run test:unit -w @qe/telemetry
npx vitest run tests/integration/telemetry.int.test.ts
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Failures diagnosable from telemetry alone (game day); every alert has a runbook.
