# 01 — The Standard 8-Step Prompt Loop

Use these for every phase, in this order. Phase packs reference them as **[LOOP-1] … [LOOP-8]**.
Replace `<PHASE>` and `<STEP>` placeholders.

---

## [LOOP-1] Inspect (no edits)
```text
Do not modify any files.
Inspect the repository for <PHASE> and report:
1. Relevant directories/packages and their current state
2. Pinned versions that matter for this phase (Node, Theia, ssh2, etc.)
3. Build/test commands that exist today and whether they pass (run them)
4. Existing contracts (API, WS, DB) this phase must respect
5. Gaps vs the phase guide's deliverables
6. Conflicts, missing prerequisites or org decisions I must provide
7. Proposed list of files to add/change
Stop after the report.
```

## [LOOP-2] Plan (no code)
```text
Produce an implementation plan for <PHASE>, limited to this phase, with sections:
1. Domain/contracts changes   2. API/WS changes   3. DB migrations
4. Backend changes            5. Frontend/Theia changes   6. Infra/config
7. Security controls (map to threat IDs T1–T23)   8. Telemetry + audit events
9. Tests (unit, integration, security, E2E) with named cases   10. Docs to update
11. Ordered steps small enough for one prompt each, each ending in a green build.
Flag every assumption. Do not write code yet.
```
> Human: review, edit, approve. Then run the phase pack's step prompts.

## [LOOP-3] Implement one step
```text
Implement step <STEP> of the approved plan only.
- Follow repository conventions and package boundaries.
- Validate external input with Zod; typed errors; timeouts; cleanup paths.
- Add the tests for this step (positive + negative) in the same change.
- Run: npm run typecheck && npm run lint && npm run test:unit (and the integration tests for touched packages).
Report using the standard response format with ACTUAL command output.
```

## [LOOP-4] Self-review (findings first)
```text
Act as a principal engineer and security reviewer. Review ALL changes in this phase (git diff main...HEAD).
Look for: broken/missing authorization, IDOR, secrets in logs/telemetry/errors, path traversal, symlink
escape, SSRF/DNS rebinding, command injection, unsafe shell use, WebSocket auth/origin flaws, missing
timeouts, resource leaks (PTY, SSH channels, sockets, timers, listeners), race conditions in state
transitions, missing audit events, missing metrics, unbounded buffers/backpressure, error messages that
leak internals, weakened tests, boundary violations, parity gaps between browser and desktop.
Output a table: severity | file:line | finding | suggested fix. Do not fix yet.
```

## [LOOP-5] Fix
```text
Fix the findings rated Critical/High/Medium that belong to this phase. For each fix add or update a test
that would have caught it. List findings you deliberately deferred and why.
Re-run typecheck, lint, unit and relevant integration tests and paste real results.
```

## [LOOP-6] Validate
```text
Run the full validation for this phase:
<paste the phase pack's validation commands>
Report actual results. If anything fails, diagnose root cause and fix it — do not skip, retry-until-green,
or loosen assertions. Do not claim completion while any required check fails.
```

## [LOOP-7] Document
```text
Update documentation for behaviour actually implemented in this phase:
- docs/architecture (contracts, diagrams) if changed
- docs/runbooks for new failure modes/alerts
- docs/user or docs/admin for new user-visible features
- ADR if a decision was made
- README dev instructions if commands changed
Do not document unimplemented behaviour.
```

## [LOOP-8] Phase gate
```text
Fill docs/phase-gates/<PHASE>.md using the template in docs (PHASE_GATE_TEMPLATE). Include: delivered
items, exact validation commands and trimmed real outputs, security review (threats, controls, negative
tests), operational review (metrics, logs, traces, alerts, runbooks), known limitations, and a
recommended decision PASS / CONDITIONAL / FAIL with reasons. Then propose a commit plan grouped by concern.
```
