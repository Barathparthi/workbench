# Prompt Pack — Phase 14: Security Hardening

Phase guide: `02_PHASES/PHASE_14_SECURITY_HARDENING.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P14.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P14.1 … P14.5 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P14.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 14 — Security Hardening
Read docs/phases/PHASE_14_SECURITY_HARDENING.md (copy of the kit's phase guide) fully before anything else.
GOAL: Close the threat model: every threat T1–T23 has control + automated test + evidence + owner.
IN SCOPE: tests/security; HTTP/WS hardening; rate limit store; docs/security
OUT OF SCOPE (do not touch): new features
ACCEPTANCE: All High threats closed or formally accepted; security suite blocking in CI; sign-off recorded.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 14`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P14.1 — Threat register

```text
Read all code paths for auth, authz, WS, SSH, file paths, exec, target registration, forwarding, containers,
logs. Produce docs/security/threat-register.md (asset, boundary, threat, exploit path, control, test,
evidence, residual risk, owner) for T1–T23 plus any new threats. Do not edit code.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P14.2 — Gap tests

```text
For every threat lacking an automated test, add it under tests/security. Report which fail.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P14.3 — Fix controls

```text
Fix failing controls: CSP/headers tuned for Theia, WS origin/caps/sizes, Redis-backed rate limits, input
limits, forwarding rejection, extension allowlist. One threat per commit with its test.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P14.4 — Scans

```text
Run SAST, SCA, secret, image and IaC scans; triage findings into fix/accept with justification; produce
evidence files.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P14.5 — Incident runbooks

```text
Write runbooks: SSH CA/credential compromise, host-key mismatch storm, suspected lateral movement, session
hijack.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npx vitest run tests/security
npm audit --audit-level=high
trivy image qews/connection-broker:ci
gitleaks detect
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: All High threats closed or formally accepted; security suite blocking in CI; sign-off recorded.
