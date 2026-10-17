# Phase 05 — Workspace Runtime and Routing

| | |
|---|---|
| **Goal** | Start/stop isolated workspace runtimes and route each browser only to its own runtime |
| **Duration** | 1.5–2 weeks |
| **Prerequisites** | Phases 02–04; ADR-005 (routing) |
| **Prompt pack** | `03_PROMPTS/PHASE_05_PROMPTS.md` |

## Deliverables
- `packages/runtime-providers`: `WorkspaceRuntimeProvider` + `DockerProvider` (dev/local) + `KubernetesProvider` (hosted).
- Lifecycle API start/stop/status (SSE), idempotent; reconciler; idle shutdown; quotas.
- Workspace router: authenticated HTTP + WebSocket reverse proxy `/w/{workspaceId}/*`.
- Hardened runtime image; Git clone on first start.

## Step-by-step

### 5.1 Provider interface
```ts
export interface RuntimeSpec {
  workspaceId: string; image: string;                 // pinned digest
  resources: { cpu: string; memory: string; pids: number; disk: string };
  env: Record<string, string>;                        // non-secret only
  git?: { url: string; ref: string };
}
export interface RuntimeStatus { phase: 'absent'|'starting'|'ready'|'stopping'|'failed'; endpoint?: string; reason?: string }
export interface WorkspaceRuntimeProvider {
  ensureStarted(spec: RuntimeSpec): Promise<RuntimeStatus>;    // idempotent
  ensureStopped(workspaceId: string): Promise<RuntimeStatus>;  // idempotent, keeps volume
  status(workspaceId: string): Promise<RuntimeStatus>;
  destroy(workspaceId: string): Promise<void>;                 // deletes volume
  list(): Promise<Array<{ workspaceId: string; status: RuntimeStatus }>>;
}
```

### 5.2 DockerProvider (dev + local web team server)
- `dockerode`; container `qews-ws-<id>`; label `qews.workspace=<id>`; named volume → `/home/qe/project`.
- `HostConfig`: `Memory`, `NanoCpus`, `PidsLimit`, `CapDrop: ['ALL']`, `SecurityOpt: ['no-new-privileges']`, `User: '1000:1000'`, tmpfs `/tmp`; **never** `Privileged`, docker.sock, or host bind mounts.
- Dedicated Docker network with no route to lab CIDRs.

### 5.3 KubernetesProvider (hosted)
Per workspace: PVC (RWO) + Pod (or 1-replica StatefulSet) + ClusterIP Service.
```yaml
spec:
  automountServiceAccountToken: false
  enableServiceLinks: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
  - name: ide
    image: registry.corp/qews/runtime-python@sha256:<digest>
    ports: [{ containerPort: 3000 }]
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
    resources:
      requests: { cpu: "500m", memory: 1Gi }
      limits:   { cpu: "2", memory: 4Gi, ephemeral-storage: 5Gi }
    readinessProbe: { httpGet: { path: /, port: 3000 }, periodSeconds: 5 }   # confirm Theia health path
    volumeMounts: [{ name: project, mountPath: /home/qe/project }]
```
- Namespace `qews-workspaces`: PSS `restricted` labels, default-deny NetworkPolicy (finalised in Phase 16).
- Init container clones the repo on first start (read-only deploy credentials via short-lived projected secret, or user-provided token in Phase 12).

### 5.4 Lifecycle service
```text
start(id): authz workspace:start → read ws
           RUNNING or STARTING → return current (idempotent)
           CAS (CREATED|STOPPED|FAILED) → STARTING, audit WORKSPACE_START
           provider.ensureStarted (background job) → ready ⇒ CAS STARTING → RUNNING
           error/timeout (180 s) ⇒ FAILED(reason)
stop(id):  symmetric and idempotent
```
- Quota: max running workspaces per user (e.g. 2) → `QUOTA_EXCEEDED`.
- `GET /workspaces/{id}/events` (SSE) pushes transitions.

### 5.5 Reconciler (every 30 s, leader via PG advisory lock)
- DB RUNNING but runtime absent → FAILED(`RUNTIME_LOST`).
- Runtime present but DB STOPPED/DELETED → stop/destroy (orphans).
- STARTING older than timeout → FAILED.

### 5.6 Idle shutdown
Router updates `last_active_at` on HTTP/WS activity (debounced 60 s); a job stops RUNNING workspaces idle longer than the profile's `idleMinutes`.

### 5.7 Workspace router
- `/w/:workspaceId/*` HTTP + WS upgrade via `@fastify/http-proxy` (websocket on) or `http-proxy`.
- Checks on every request **and** WS upgrade: valid session, allowed Origin (WS), workspace membership, workspace RUNNING.
- Upstream comes from the provider (`http://qews-ws-<id>.qews-workspaces.svc:3000`), never from client input.
- Strip `cookie` and `authorization` before proxying (runtime never sees the platform session).
- Close proxied WS on logout/revocation; WS keepalive pings.

### 5.8 Runtime image hardening
- UID 1000, no sudo, setuid bits removed where safe, `tini` as PID 1.
- Template images `runtime-python`, `runtime-java`, `runtime-node` on a shared base.
- Package caches (pip/maven/npm) on the volume for fast restarts.

## Tests
- Unit: lifecycle decision table (state × command).
- Docker integration: start → ready → stop → start reuses volume; double start/stop idempotent; security options asserted.
- kind integration: pod passes PSS restricted; PVC retained after stop.
- Security: user B → `/w/{A}/` (HTTP and WS) → 404; runtime never receives platform cookie.
- E2E: login → create → start → IDE loads → terminal `echo QE_OK`.

## Exit criteria
- [ ] **Milestone M1** works in compose and in a dev cluster.
- [ ] No orphans after 50 start/stop cycles (script).
- [ ] Cross-workspace access tests green.
