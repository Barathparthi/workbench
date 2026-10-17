# 12 — CI/CD, Supply Chain and Release

## 1. Pipeline overview

```text
PR ─► verify (install, typecheck, lint, unit, integration, contract, security unit tests, build)
   ─► scan (SCA, SAST, secrets, IaC) ─► images (build, scan, SBOM) ─► preview env (optional)
merge to main ─► build & sign images (digest) ─► deploy DEV ─► smoke + E2E + parity
tag vX.Y.Z  ─► promote same digests ─► STAGING (approval) ─► E2E + load gate + DAST
           ─► PROD (approval, change record) ─► progressive rollout ─► post-deploy verification
           ─► desktop installers built/signed/published for the same version
```

## 2. GitHub Actions skeleton (adapt to your CI)

```yaml
# .github/workflows/ci.yml
name: ci
on: { pull_request: {}, push: { branches: [main] } }
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: actions/setup-node@<pinned-sha>
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test:unit -- --coverage
      - run: npm run test:integration       # uses Docker on the runner (testcontainers)
      - run: npm run build
      - run: npm run openapi:check          # oasdiff vs main
  security:
    runs-on: ubuntu-latest
    permissions: { contents: read, security-events: write }
    steps:
      - uses: actions/checkout@<pinned-sha>
      - run: npx --yes osv-scanner --lockfile=package-lock.json   # or org SCA
      - uses: gitleaks/gitleaks-action@<pinned-sha>
      - uses: github/codeql-action/init@<pinned-sha>
        with: { languages: javascript-typescript }
      - uses: github/codeql-action/analyze@<pinned-sha>
  images:
    needs: [verify]
    runs-on: ubuntu-latest
    strategy: { matrix: { image: [control-plane, connection-broker, workspace-runtime] } }
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: docker/setup-buildx-action@<pinned-sha>
      - run: docker buildx build -f images/${{ matrix.image }}/Dockerfile -t qews/${{ matrix.image }}:ci --load .
      - run: trivy image --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed qews/${{ matrix.image }}:ci
      - run: syft qews/${{ matrix.image }}:ci -o cyclonedx-json > sbom-${{ matrix.image }}.json
      - uses: actions/upload-artifact@<pinned-sha>
        with: { name: sbom-${{ matrix.image }}, path: sbom-${{ matrix.image }}.json }
  deploy-manifests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
      - run: helm lint deploy/helm/qe-workspace
      - run: helm template deploy/helm/qe-workspace -f deploy/helm/values-prod.yaml | kubeconform -strict -summary
      - run: checkov -d deploy --quiet
  desktop:
    if: github.event_name == 'push'
    strategy: { matrix: { os: [windows-latest, macos-latest, ubuntu-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: actions/setup-node@<pinned-sha>
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci && npm run build -w @qe/ide-electron && npm run package -w @qe/ide-electron
```

Pin third-party actions by **commit SHA**. Use OIDC federation from CI to the registry/cloud (no long-lived CI secrets).

## 3. Image standards

```dockerfile
# images/control-plane/Dockerfile (pattern)
FROM node:<lts>-bookworm-slim@sha256:<digest> AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY packages ./packages
RUN npm ci --workspaces --include-workspace-root
COPY apps/control-plane apps/control-plane
RUN npm run build -w @qe/control-plane && npm prune --omit=dev

FROM gcr.io/distroless/nodejs<lts>-debian12:nonroot@sha256:<digest>
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/control-plane/dist ./dist
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "dist/main.js"]
```
- Workspace runtime image is **not** distroless (users need shells/tools) but runs as non-root UID 1000,
  no sudo, no setuid binaries where removable.
- Labels: `org.opencontainers.image.source/revision/version`.
- Sign with cosign (keyless via CI OIDC or KMS key); attach SBOM attestation.
- Cluster admission (Kyverno/Gatekeeper/sigstore policy-controller) verifies signatures.

## 4. Versioning & artifacts

- SemVer tags `vX.Y.Z`; all images and desktop installers share the version.
- Helm chart version = app version; values per environment in `deploy/helm/values-<env>.yaml`.
- Deploy by **digest**, not tag.
- Changelog generated from Conventional Commits.

## 5. Environments

| Env | Deploy | Data | Purpose |
|---|---|---|---|
| dev | every merge | synthetic | integration, E2E |
| staging | on tag, approval | prod-like, synthetic targets | E2E, load, DAST, rollback drills |
| prod | approval + change record | real | users |

## 6. Progressive delivery

- Control plane & broker: rolling update `maxUnavailable: 0`, `maxSurge: 1`, readiness gates,
  PDB `minAvailable: 1`. Optional canary via Argo Rollouts with SLO-based analysis.
- Broker drain: on SIGTERM stop accepting new sessions, send WS close 4013 after grace period
  (e.g. 10 min max, configurable) — users reconnect to new pods.
- Runtimes: new image applies on next workspace start; force-restart policy for security patches.

## 7. Rollback

- `helm rollback qe-workspace <rev>` (or Argo CD revert) — restores previous digests and config.
- DB: expand/contract guarantees N-1 compatibility; never deploy contract migrations in the same
  release as the code that stops using the old schema.
- Rollback drill in staging every release candidate (Phase 17).

## 8. Post-deploy verification (automated)
1. `/readyz` on all services. 2. Synthetic login (service test user). 3. Start test workspace.
4. Terminal echo via API test harness. 5. SSH connect to canary target. 6. Run sample test.
7. Check dashboards for error-rate regression for 15 min → auto-rollback on breach.
