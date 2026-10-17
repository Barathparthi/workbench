# Prompt Pack — Phase 06: Integrated Terminal Hardening

Phase guide: `02_PHASES/PHASE_06_INTEGRATED_TERMINAL_HARDENING.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P06.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P06.1 … P06.5 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P06.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 06 — Integrated Terminal Hardening
Read docs/phases/PHASE_06_INTEGRATED_TERMINAL_HARDENING.md (copy of the kit's phase guide) fully before anything else.
GOAL: Verify and harden Theia's built-in terminal in the runtime: interactivity, resize, Ctrl+C, limits, cleanup, telemetry.
IN SCOPE: tests/e2e/terminal*; extensions/qe-core backend contribution; runtime image config
OUT OF SCOPE (do not touch): remote terminal (Phase 08)
ACCEPTANCE: All terminal behaviours green in hosted, local-web and Electron; limits enforced.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 06`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P06.1 — E2E first

```text
Write Playwright tests for every behaviour in the phase guide table 6.1 using stable Theia selectors and
explicit waits. Run them and report which fail today.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P06.2 — Shell config + limits

```text
Configure default shell, allowlisted shells, TERM/LANG, banner, scrollback cap, max terminals per workspace
enforced in a backend contribution. Tests for the limit.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P06.3 — Cleanup

```text
Ensure PTY process groups receive SIGHUP then SIGKILL after 5 s on close; verify no zombies with tini.
Integration test.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P06.4 — Telemetry

```text
Add terminal metrics (active, open duration, disconnects) without capturing any bytes. Unit test that no
payload data reaches telemetry.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P06.5 — Abuse tests

```text
Add fork-bomb and output-flood tests in an isolated test workspace proving limits hold and other workspaces
are unaffected.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npx playwright test tests/e2e/terminal.spec.ts --project=hosted --project=local-web
npm run test:integration
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: All terminal behaviours green in hosted, local-web and Electron; limits enforced.
