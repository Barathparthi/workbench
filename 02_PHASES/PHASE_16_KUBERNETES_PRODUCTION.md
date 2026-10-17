# Phase 16 — Kubernetes Production Deployment

| | |
|---|---|
| **Goal** | Hardened, repeatable Helm deployment on the org's cluster |
| **Duration** | 1.5 weeks |
| **Prerequisites** | Phases 05, 12, 13, 15 |
| **Prompt pack** | `03_PROMPTS/PHASE_16_PROMPTS.md` |

## Namespaces
| Namespace | Workloads | PSS |
|---|---|---|
| `qews-system` | control-plane, broker, migration job | restricted |
| `qews-workspaces` | workspace pods | restricted |
| `qews-observability` | collector (if not shared) | restricted/baseline |

## Step-by-step
1. **Helm chart** `deploy/helm/qe-workspace`: deployments (control-plane ×3, broker ×2+), services, ingress (TLS via cert-manager or org certs), ConfigMaps, ExternalSecrets/CSI secret references, ServiceAccounts, RBAC, PDBs, HPA (control plane), migration Job (pre-install/pre-upgrade hook), NetworkPolicies.
2. **Security contexts** on all pods: `runAsNonRoot`, `readOnlyRootFilesystem: true` (control plane/broker), drop ALL caps, `allowPrivilegeEscalation: false`, seccomp RuntimeDefault, `automountServiceAccountToken: false` except control plane (needs K8s API for workspaces).
3. **Control plane RBAC**: Role in `qews-workspaces` only — create/get/list/delete pods, services, PVCs; no secrets read, no exec.
4. **NetworkPolicies** (default deny both directions in each namespace), allows:
   - ingress-controller → control-plane:8080, broker:8081 (stream paths).
   - control-plane → postgres, IdP (egress), K8s API, broker internal, workspace pods:3000.
   - broker → control-plane internal, Vault, DNS, **lab CIDRs:22 only**.
   - workspace pods ← control-plane only; → DNS, Git host, package mirrors, Open VSX mirror, OTel collector. **No** lab CIDRs, no control-plane, no other workspaces, no cloud metadata IP.
5. **Ingress**: WebSocket timeouts (≥ 1 h read timeout for `/w/*` and stream paths), body size limits, sticky routing for broker streams if multiple replicas (or replica-addressed URLs).
6. **Probes**: liveness `/healthz`, readiness `/readyz`, startup probe for slow Theia boot in runtime pods.
7. **Graceful shutdown**: `terminationGracePeriodSeconds` ≥ broker drain; `preStop` sleep 5 s for endpoint removal.
8. **Scheduling**: workspace node pool with taints/tolerations; ResourceQuota + LimitRange in `qews-workspaces`; PriorityClass so system pods outrank workspaces.
9. **Optional sandboxing**: gVisor/Kata RuntimeClass for workspaces if threat model requires.
10. **Admission policies** (Kyverno/Gatekeeper): require signed images from internal registry, forbid privileged/hostPath/hostNetwork, require limits.
11. **Backups**: managed PG PITR; VolumeSnapshot schedule for workspace PVCs; restore runbook.
12. **Smoke job** after install/upgrade.

## Tests
- `helm template | kubeconform`, `kube-linter`, `checkov` in CI.
- In a kind/staging cluster: NetworkPolicy tests (pod-to-pod deny, workspace → lab CIDR blocked, broker → lab allowed, workspace → 169.254.169.254 blocked).
- Fresh namespace install → smoke green; `helm rollback` → smoke green.

## Exit criteria
- [ ] **Milestone M4**: SSO + RBAC + audit + observability on hardened Kubernetes.
- [ ] Clean-cluster install and rollback demonstrated.
