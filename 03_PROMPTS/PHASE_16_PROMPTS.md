# Prompt Pack — Phase 16: Kubernetes Production

Phase guide: `02_PHASES/PHASE_16_KUBERNETES_PRODUCTION.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P16.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P16.1 … P16.6 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P16.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 16 — Kubernetes Production
Read docs/phases/PHASE_16_KUBERNETES_PRODUCTION.md (copy of the kit's phase guide) fully before anything else.
GOAL: Hardened Helm chart: namespaces, PSS restricted, NetworkPolicies, RBAC, probes, PDB/HPA, secrets via references, migration job, backups.
IN SCOPE: deploy/helm/qe-workspace; deploy/policies; tests/k8s
OUT OF SCOPE (do not touch): app features
ACCEPTANCE: Milestone M4; clean install and rollback demonstrated.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 16`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P16.1 — Chart structure

```text
Create the umbrella chart with templates listed in the guide, values per environment, no secrets in values
(ExternalSecrets/CSI references).

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P16.2 — Pod security

```text
Apply security contexts to every workload, minimal control-plane RBAC scoped to qews-workspaces,
ServiceAccount token automount off where not needed.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P16.3 — NetworkPolicies

```text
Default deny + explicit allows exactly as in the guide. Add tests/k8s scripts that verify each allow/deny in a
kind cluster with a NetworkPolicy-capable CNI.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P16.4 — Ingress + shutdown

```text
Ingress WS timeouts, body limits, broker session affinity strategy; probes; preStop and grace periods matching
broker drain.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P16.5 — Scheduling + quotas + admission

```text
Workspace node pool taints/tolerations, ResourceQuota/LimitRange, PriorityClasses, Kyverno/Gatekeeper policies
(signed images, no privileged/hostPath/hostNetwork, limits required).

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P16.6 — Install/rollback proof

```text
Fresh-namespace install → smoke job green → helm rollback → smoke green. Record evidence.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
helm template deploy/helm/qe-workspace -f deploy/helm/values-staging.yaml | kubeconform -strict -summary
kube-linter lint deploy/helm/qe-workspace
bash tests/k8s/netpol.sh
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Milestone M4; clean install and rollback demonstrated.
