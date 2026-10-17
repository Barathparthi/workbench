# Prompt Pack — Phase 11: QE Test Runner & Reports

Phase guide: `02_PHASES/PHASE_11_QE_TEST_RUNNER_AND_REPORTS.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P11.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P11.1 … P11.6 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P11.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 11 — QE Test Runner & Reports
Read docs/phases/PHASE_11_QE_TEST_RUNNER_AND_REPORTS.md (copy of the kit's phase guide) fully before anything else.
GOAL: RunnerAdapter (pytest first), structured execution locally and remotely, streaming JUnit parsing, run records, QE Test panel.
IN SCOPE: extensions/qe-runner; packages/domain runner types; control-plane test-runs API; broker exec; tests/fixtures/sample-pytest-repo
OUT OF SCOPE (do not touch): CI replacement features
ACCEPTANCE: Milestone M3: same project, desktop + web, test run with parsed results and report; injection tests green.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 11`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P11.1 — Domain + adapter

```text
Implement run types and RunnerAdapter; PytestAdapter buildCommand/discover with strict selector validation and
argv-only construction. Injection unit tests.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P11.2 — Local execution

```text
Backend runner service: spawn without shell, process-group cancel (SIGINT→SIGKILL 10 s), concurrency limit,
ring-buffered streaming to client, full log file.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P11.3 — Results

```text
Streaming JUnit parser (saxes) handling pytest and surefire, caps on failure text; persist run summary and
artifacts with sha256 via control plane API. Fixture tests incl. 50 MB file.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P11.4 — Remote execution

```text
Control-plane remote test-run endpoint (qe_test:execute + remote:execute) → broker exec with the single
quoting helper (hostile-input tests) → artifacts via SFTP.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P11.5 — QE panel

```text
Test tree, run/cancel, live console, summary, failure click-to-source, artifacts and history. E2E on the
sample repo (3 pass, 1 fail, 1 skip).

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P11.6 — Maven adapter

```text
Add MavenSurefireAdapter reusing the parser; integration test with a sample Maven project.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run test:unit -w @qe/theia-qe-runner
npm run test:integration
npx playwright test tests/e2e/runner.spec.ts
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Milestone M3: same project, desktop + web, test run with parsed results and report; injection tests green.
