# Prompt Pack — Phase 12: Enterprise SSO, Secrets & Audit

Phase guide: `02_PHASES/PHASE_12_ENTERPRISE_SSO_SECRETS_AUDIT.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P12.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P12.1 … P12.5 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P12.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 12 — Enterprise SSO, Secrets & Audit
Read docs/phases/PHASE_12_ENTERPRISE_SSO_SECRETS_AUDIT.md (copy of the kit's phase guide) fully before anything else.
GOAL: Corporate OIDC by configuration, SecretProvider with Vault, short-lived SSH certificates, removal of dev paths in prod, audit completeness and viewer.
IN SCOPE: packages/secrets; broker credential source; control-plane auth config; extensions/qe-admin audit view; scripts/target-onboard.sh
OUT OF SCOPE (do not touch): new features
ACCEPTANCE: Corporate SSO in staging; SSH via short-lived certs; audit coverage and chain verification green.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 12`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P12.1 — Corporate OIDC

```text
Make IdP fully config-driven (issuer, clients, scopes, ROLE_MAPPINGS, group overage handling). Add periodic
user-status revalidation that kills web and broker sessions for disabled users. Tests with the dev IdP
simulating disablement.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P12.2 — SecretProvider + Vault

```text
Implement SecretProvider and VaultProvider using Kubernetes auth, timeouts, retries with jitter, circuit
breaker; health(). Integration tests with Vault dev container.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P12.3 — SSH certificates

```text
VaultCredentialSource: ephemeral ed25519 per connection, sign with principals/TTL ≤ 15 min, connect with cert
(approach from spike S4), zero-fill key, audit CREDENTIAL_ISSUED with serial only. Write scripts/target-
onboard.sh to configure TrustedUserCAKeys on targets.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P12.4 — Prod guards

```text
Startup fails in production with AUTH_MODE=dev or file-dev secret provider. Container test proving exit code.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P12.5 — Audit completeness

```text
Audit coverage test performing every privileged action and asserting the event; audit viewer with filters,
pagination and CSV export; nightly hash-chain verify + archive job with alert on break.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run test:integration -w @qe/secrets
npm run test:integration -w @qe/connection-broker
npx vitest run tests/security/audit-coverage.test.ts
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Corporate SSO in staging; SSH via short-lived certs; audit coverage and chain verification green.
