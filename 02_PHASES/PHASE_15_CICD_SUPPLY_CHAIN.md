# Phase 15 — CI/CD and Supply Chain

| | |
|---|---|
| **Goal** | Every release is reproducible, scanned, signed, SBOM'd and promoted dev → staging → prod by pipeline |
| **Duration** | 1 week |
| **Prerequisites** | Phase 01 CI skeleton; registry and cluster access |
| **Prompt pack** | `03_PROMPTS/PHASE_15_PROMPTS.md` |

## Step-by-step
1. Expand `ci.yml` to the full job set in `01_ARCHITECTURE/12_CICD_AND_RELEASE.md` §2 (verify, security, images, deploy-manifests, desktop).
2. Pin all third-party actions by SHA; least-privilege `permissions:` per job.
3. CI → registry auth via OIDC federation; no long-lived secrets.
4. Multi-stage Dockerfiles for control-plane, broker (distroless) and runtime images (non-root); base images by digest.
5. Trivy/Grype gate (Critical/High fail, `--ignore-unfixed` with exception file reviewed monthly).
6. Syft SBOM (CycloneDX) per image; attach as cosign attestation; sign images (cosign keyless or KMS).
7. Release workflow on tag `v*`: build once, push by digest, write digests into `deploy/helm/values-<env>.yaml` via PR or Argo CD image updater.
8. Deploy dev automatically on main; staging/prod require environment approvals.
9. Post-deploy verification job (`12_CICD §8`) with auto-rollback on failure.
10. Desktop: build, sign (Windows code signing cert, Apple notarization), checksum, publish to internal distribution.
11. Changelog from Conventional Commits; release notes template.
12. Renovate/Dependabot for npm, Docker digests, actions.

## Tests
- Pipeline fails on: lint error, failing test, Critical CVE, leaked secret (seeded test), unsigned image (admission in dev cluster), breaking OpenAPI change.
- Rebuild from tag on clean runner produces the same image digest (or documented non-determinism).

## Exit criteria
- [ ] Tagged release deployed to staging from a clean checkout with no manual steps.
- [ ] All blocking gates demonstrated to block.
