# Prompt Pack — Phase 15: CI/CD & Supply Chain

Phase guide: `02_PHASES/PHASE_15_CICD_SUPPLY_CHAIN.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P15.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P15.1 … P15.5 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P15.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 15 — CI/CD & Supply Chain
Read docs/phases/PHASE_15_CICD_SUPPLY_CHAIN.md (copy of the kit's phase guide) fully before anything else.
GOAL: Full pipeline: verify, scan, build, SBOM, sign, promote by digest dev→staging→prod with approvals, desktop signing, auto-rollback.
IN SCOPE: .github/workflows; images/*; deploy/helm values; renovate config
OUT OF SCOPE (do not touch): application code changes
ACCEPTANCE: Tagged release deploys to staging from clean checkout; every gate proven to block.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 15`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P15.1 — Pipeline jobs

```text
Expand CI to verify/security/images/deploy-manifests/desktop per the CI/CD doc with SHA-pinned actions, least
privileges and OIDC registry auth.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P15.2 — Images + SBOM + signing

```text
Finalise multi-stage Dockerfiles (distroless for services, non-root runtime), Trivy gate, Syft SBOM, cosign
signing and attestation.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P15.3 — Release + promotion

```text
Tag workflow: build once, push by digest, update env values, deploy dev automatically, staging/prod with
environment approvals, post-deploy verification with auto-rollback.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P15.4 — Desktop release

```text
Signed Windows/macOS/Linux installers with checksums published to internal distribution.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P15.5 — Prove the gates

```text
Create throwaway PRs/branches demonstrating each gate blocks: lint, test, CVE, secret, unsigned image, OpenAPI
breaking change. Record evidence.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
act -j verify (or run in CI)
helm lint deploy/helm/qe-workspace
cosign verify <image@digest>
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Tagged release deploys to staging from clean checkout; every gate proven to block.
