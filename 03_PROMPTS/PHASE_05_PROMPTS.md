# Prompt Pack — Phase 05: Workspace Runtime & Routing

Phase guide: `02_PHASES/PHASE_05_WORKSPACE_RUNTIME_AND_ROUTING.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P05.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P05.1 … P05.7 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P05.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 05 — Workspace Runtime & Routing
Read docs/phases/PHASE_05_WORKSPACE_RUNTIME_AND_ROUTING.md (copy of the kit's phase guide) fully before anything else.
GOAL: Isolated per-workspace runtimes via Docker and Kubernetes providers, idempotent lifecycle, reconciler, idle stop, and an authenticated HTTP/WS router.
IN SCOPE: packages/runtime-providers; apps/control-plane lifecycle + router; images/workspace-runtime; deploy/k8s dev manifests
OUT OF SCOPE (do not touch): remote SSH; production Helm (Phase 16)
ACCEPTANCE: Milestone M1 demonstrable in compose and dev cluster; no orphans; cross-workspace tests green.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 05`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P05.1 — Provider interface + Docker

```text
Implement WorkspaceRuntimeProvider and DockerProvider with the exact HostConfig hardening in the guide (non-
root, CapDrop ALL, no-new-privileges, PidsLimit, memory/cpu, named volume, isolated network, no docker.sock or
host mounts). Integration tests assert inspect() security options and idempotency.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P05.2 — Kubernetes provider

```text
Implement KubernetesProvider creating PVC+Pod+Service with the pod spec from the guide (PSS restricted
compatible, automountServiceAccountToken false). Test against kind: pod admitted under restricted namespace
labels; PVC retained after stop.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P05.3 — Lifecycle service + API

```text
Implement start/stop with CAS transitions, background readiness wait, timeout → FAILED, per-user running
quota, audit, SSE events endpoint. Unit decision-table tests + integration with DockerProvider.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P05.4 — Reconciler + idle stop

```text
Implement leader-elected (advisory lock) reconciler and idle-stop job per the guide. Tests for runtime-lost,
orphan cleanup, stuck STARTING.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P05.5 — Workspace router

```text
Implement /w/:workspaceId/* HTTP+WS proxy: session, Origin (WS), membership, RUNNING checks on every request
and upgrade; upstream from provider only; strip cookie/authorization; activity tracking; close on logout.
Security tests: cross-user HTTP and WS → 404; runtime never sees platform cookie.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P05.6 — Git clone on first start

```text
Add first-start clone (init container / docker exec) with validated git URL (https only, allowlisted hosts).
Tests for invalid URLs.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P05.7 — M1 E2E

```text
Playwright: login → create workspace → start → IDE loads at /w/{id}/ → terminal echo QE_OK. Plus a 50-cycle
start/stop script that asserts no orphans.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run test:integration -w @qe/runtime-providers
npm run test:integration -w @qe/control-plane
npx playwright test tests/e2e/m1.spec.ts
scripts/lifecycle-cycle.sh 50
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Milestone M1 demonstrable in compose and dev cluster; no orphans; cross-workspace tests green.
