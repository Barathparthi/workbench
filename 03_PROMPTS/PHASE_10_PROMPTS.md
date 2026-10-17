# Prompt Pack — Phase 10: Local Desktop & Local Web

Phase guide: `02_PHASES/PHASE_10_LOCAL_DESKTOP_AND_LOCAL_WEB.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P10.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P10.1 … P10.7 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P10.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 10 — Local Desktop & Local Web
Read docs/phases/PHASE_10_LOCAL_DESKTOP_AND_LOCAL_WEB.md (copy of the kit's phase guide) fully before anything else.
GOAL: Embedded broker for personal targets, desktop OIDC for managed targets, localhost-only local web mode, signed installers, parity suite.
IN SCOPE: extensions/qe-remote electron/backend modules; packages/broker-core sources; apps/ide-electron packaging; deploy/compose/docker-compose.local-web.yml; tests/parity
OUT OF SCOPE (do not touch): hosted infra
ACCEPTANCE: Desktop and local web match hosted behaviour; parity suite green.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 10`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P10.1 — Pluggable sources

```text
In broker-core add interfaces TargetSource, CredentialSource, HostKeyStore, AddressGuard, AuditSink if not
already, and implement SshConfigTargetSource, AgentCredentialSource (SSH_AUTH_SOCK, Windows openssh-ssh-agent
pipe, pageant fallback, IdentityFile+passphrase prompt), KnownHostsStore (hashed, cert-authority, revoked).
Unit tests with fixture files.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P10.2 — Embedded broker service

```text
Expose EmbeddedBrokerService via Theia RPC in backendElectron (and backend when QE_MODE=local-web), carrying
qews.v1 messages. CompositeConnectionClient merges managed + personal targets in the UI.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P10.3 — Host-key UX

```text
Unknown key modal (trust once / trust and save / cancel) with algorithm+fingerprint; mismatch hard error;
managed setting to disable TOFU. Tests.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P10.4 — Desktop sign-in

```text
OIDC auth code + PKCE via system browser and loopback redirect; refresh token in Electron safeStorage; bearer
calls to hosted control plane/broker. Test token is never written in plaintext.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P10.5 — Local web mode

```text
localhost-only binding, one-time URL token → HttpOnly cookie, compose file + launcher scripts (bash +
PowerShell) mounting project and ~/.ssh read-only. Security tests.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P10.6 — Packaging + managed settings

```text
electron-builder configs for Windows/macOS/Linux, signing placeholders, managed policy file locations per OS,
read at startup with Zod validation.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P10.7 — Parity suite

```text
Implement tests/parity scenarios parameterised over hosted, local-web and desktop projects; wire hosted+local-
web into PR CI and desktop into nightly matrix.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run test:unit -w @qe/broker-core
npm run test:integration -w @qe/broker-core
npx playwright test tests/parity --project=local-web
npm run package -w @qe/ide-electron
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Desktop and local web match hosted behaviour; parity suite green.
