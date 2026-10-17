# 02 — Solution Architecture

## 1. Architectural principles

| # | Principle | Consequence |
|---|---|---|
| P1 | Browser is an untrusted client | No process/FS/SSH/secrets/policy in frontend code |
| P2 | Reuse Theia, don't rebuild an IDE | Use Theia's editor, explorer, terminal (xterm.js + node-pty), plugin host |
| P3 | One workspace contract, many clients | Shared extensions; environment-specific code only behind interfaces |
| P4 | Control plane ≠ execution plane | Control plane never runs user code; runtimes never hold platform secrets |
| P5 | Policy before network | Authorization and SSRF checks happen *before* any outbound connection |
| P6 | Modular monolith first | Few deployables, strict package boundaries (ADR-003) |
| P7 | Secure by default | Deny-by-default network, capabilities off by default, fail closed |
| P8 | Observable by construction | Every boundary emits trace/metrics/logs; privileged actions emit audit |
| P9 | The runtime is user-controlled | Anything inside a workspace runtime is treated as the user's own code |

## 2. Deployables

| Deployable | Tech | Replicas | Owns |
|---|---|---|---|
| `control-plane` | Node/TS, Fastify | 2+ (stateless) | API, OIDC session, RBAC, workspace & target metadata, policy, audit write, **workspace router** (HTTP/WS reverse proxy) |
| `connection-broker` | Node/TS, `ssh2` | 2+ (stateful sessions, sticky) | SSH connections, PTY/exec/SFTP channels, host-key verification, credential resolution |
| `workspace-runtime` (image) | Theia backend + toolchains | 1 per active workspace | Theia backend, FS, PTY, language servers, plugin host, local test runs |
| `desktop app` | Theia Electron | per user machine | Local FS/PTY + embedded broker + optional control-plane client |
| `local-web` (image/compose) | Same runtime image + embedded broker | 1 per machine | Single-user local web mode |
| PostgreSQL | Managed | HA | Metadata, sessions, audit |
| Secret manager | Vault/KV | HA | Credentials, SSH CA |
| OTel Collector | — | 2 | Telemetry pipeline |

> The control plane and broker are separate deployables because their **security and scaling profiles
> differ**: the broker holds live credentials and outbound network rights; the control plane does not.

## 3. Logical view

```text
┌──────────────────────────── Browser (Theia frontend) ───────────────────────────────┐
│ Monaco editor │ Explorer │ Terminal (xterm.js) │ QE panels │ Remote Connections view │
│     │               │              │                │                │              │
│     └──── Theia RPC over WS (/w/{ws}/services) ─────┘      REST + WS (/api/v1/...)  │
└──────────────────────────────┬──────────────────────────────────────┬───────────────┘
                               │ HTTPS/WSS                            │ HTTPS/WSS
                      ┌────────▼──────────────────────────────────────▼────────┐
                      │                 Ingress (TLS termination)               │
                      └────────┬──────────────────────────────────────┬────────┘
                               │ /w/{workspaceId}/*                    │ /api/v1/*, /auth/*
                 ┌─────────────▼─────────────┐           ┌────────────▼─────────────┐
                 │  control-plane: router     │◄─────────►│ control-plane: API       │
                 │  - session cookie check    │           │ - OIDC, RBAC, policy     │
                 │  - membership check        │           │ - workspaces, targets    │
                 │  - proxy HTTP+WS to pod    │           │ - sessions, tickets      │
                 └─────────────┬─────────────┘           │ - audit writer           │
                               │ cluster network          └──┬───────┬──────┬───────┘
                 ┌─────────────▼─────────────┐               │       │      │
                 │ workspace-runtime pod (1/ws)│              │PG     │Vault │ mTLS gRPC/HTTP
                 │ Theia backend, node-pty,    │              ▼       ▼      ▼
                 │ FS on PVC, LSPs, plugins    │         ┌──────────────────────────┐
                 └─────────────────────────────┘         │ connection-broker        │
                                                         │ policy re-check, secrets,│
            Browser ── WSS /api/v1/sessions/{id}/stream ─►│ host-key verify, ssh2    │
                     (via ingress → broker, ticket auth) └────────────┬─────────────┘
                                                                      │ SSH (egress-allowlisted)
                                                               ┌──────▼───────┐
                                                               │Remote targets│
                                                               └──────────────┘
```

### Why the remote terminal goes browser → broker (not through the runtime)

The workspace runtime executes the user's arbitrary code (P9). If the runtime held SSH session
capabilities, any script in the workspace could reuse them. Routing remote terminals and remote file
operations **from the frontend directly to the broker** (authenticated with the user's session + a
single-use ticket) keeps credentials and target reachability out of the runtime. Runtimes get **no
network egress to lab CIDRs** by default.

> Exception (configurable per policy): "remote exec from tests" (US-33) is executed by the **broker**
> on behalf of the runner, never by giving the runtime raw SSH access.

## 4. Component responsibilities

### 4.1 Theia frontend extensions (`extensions/*` → browser & electron)
- `qe-core`: branding, commands, settings schema, status bar, environment detection (`hosted|local-web|desktop`).
- `qe-workspaces`: workspace picker, lifecycle UI (hosted mode).
- `qe-remote`: Remote Connections tree view, connect/disconnect, remote terminal widget, `qe-ssh://`
  `FileSystemProvider` registered in Theia's `FileService`.
- `qe-runner`: test explorer/panel, run/cancel, results, artifacts.
- `qe-audit` (admin): audit viewer.

All frontend extensions talk only to **interfaces** (`WorkspaceClient`, `ConnectionClient`,
`RunnerClient`). Each mode binds a different implementation (see `09_LOCAL_AND_WEB_PARITY.md`).

### 4.2 Theia backend (inside runtime / desktop)
- Standard Theia backend: filesystem, terminal (node-pty), processes, plugin host, search (ripgrep).
- `qe-runner` backend contribution: runs local test commands via structured argv (no shell
  interpolation), streams output, parses JUnit XML.
- Desktop only: `embedded-broker` backend contribution.

### 4.3 Control plane
Modules (each a package with its own tests): `auth`, `users`, `rbac`, `workspaces`, `runtime-provider`
(K8s/Docker), `router`, `targets`, `policy`, `sessions`, `audit`, `runner-records`, `admin`.

### 4.4 Connection broker
Modules: `api` (internal + public stream endpoints), `policy-recheck`, `credential-resolver`,
`host-key-verifier`, `ssrf-guard`, `ssh-transport` (adapter over `ssh2`), `channels` (pty, exec, sftp),
`session-registry`, `limits`, `audit-emitter`.

## 5. Key flows

### 5.1 Open a hosted workspace

```text
Browser            Ingress   Control plane (API+router)        K8s / Runtime provider     Runtime pod
  │ GET /                │            │                                  │                      │
  │ 302 → IdP (OIDC) ────┼────────────► /auth/login → /auth/callback     │                      │
  │ ◄── Set-Cookie qews_session (HttpOnly, Secure, SameSite=Lax)         │                      │
  │ GET /api/v1/workspaces ──────────► list (RBAC filter)                │                      │
  │ POST /api/v1/workspaces/{id}/start ► authz workspace:start           │                      │
  │                                  │ state CREATED/STOPPED→STARTING ──► create pod+PVC+svc ──►│ boot
  │ poll / SSE status ◄──────────────┤ ◄── readiness (Theia /healthz) ───┤◄─────────────────────│
  │ GET /w/{id}/ (IDE) ──────────────► router: cookie+membership ───────────────────────────────►│
  │ WS /w/{id}/services (Theia RPC) ─► router upgrades + pins to pod ───────────────────────────►│
```

### 5.2 Open a remote SSH terminal (hosted)

```text
1. Frontend: POST /api/v1/targets/{tid}/sessions {kind:"terminal", cols, rows, workspaceId}
2. Control plane: authn → authz(remote:connect + terminal:open on target via policy)
                 → rate-limit → create session(REQUESTED→AUTHORIZED) → audit CONNECT_ALLOWED
                 → mint single-use ticket (60 s, bound to session+user+origin)
3. Response 201 {sessionId, streamUrl:"/api/v1/sessions/{id}/stream", ticket}
4. Frontend: WSS streamUrl with Sec-WebSocket-Protocol: "qews.v1, ticket.<ticket>"
5. Broker: validate ticket (one-time, via control plane introspection or signed JWT + replay cache)
          → re-check policy (defence in depth) → SSRF guard: resolve & validate IP
          → credential resolver: obtain short-lived SSH cert / key from Vault
          → ssh2 connect to pinned IP, hostVerifier = host-key verifier (fail closed)
          → open PTY channel (cols/rows) → session ACTIVE → audit SSH_SESSION_OPENED
6. Bytes stream both ways using the terminal protocol (05_API_CONTRACTS.md §4)
7. Close: user/idle/absolute timeout/revocation → channel end → conn end → CLOSED → audit
```

### 5.3 Remote file edit

```text
Frontend FileService ─ qe-ssh://{targetId}/{path} ─► QeSshFileSystemProvider (frontend)
   └─ REST /api/v1/sessions/{fsSessionId}/fs/{op} ─► broker: confine path to remoteRoot
        → SFTP op with size/time limits → result/ETag (mtime+size) → audit REMOTE_FILE_WRITE (writes only)
```

### 5.4 Desktop mode (local)

```text
Electron frontend ──IPC/local WS──► Electron backend (Node)
    local FS / node-pty (user's own machine, user's permissions)
    embedded broker: personal targets (~/.ssh/config, ssh-agent, ~/.ssh/known_hosts)
    managed targets: OIDC (system browser + PKCE) → hosted control plane → hosted broker
```

## 6. State machines

### 6.1 Workspace
```text
CREATED ──start──► STARTING ──ready──► RUNNING ──stop/idle──► STOPPING ──► STOPPED
   ▲                  │                   │                                   │
   │                  └──error──► FAILED ◄┘ (crash)                          │
   └──────────────────────────── start (resume) ◄──────────────────────────────┘
DELETING ──► DELETED (terminal)
```
Rules: `start` on STARTING/RUNNING is a no-op returning current state (idempotent). `stop` on
STOPPED is a no-op. Transitions are compare-and-set in SQL (`UPDATE … WHERE state = $expected`).
A **reconciler** loop compares DB state with actual pods every 30 s and repairs drift.

### 6.2 Remote session
```text
REQUESTED → AUTHORIZED → CONNECTING → ACTIVE → CLOSING → CLOSED
     │            │            │          │
     └─► DENIED   └─► EXPIRED  └─► FAILED └─► REVOKED → CLOSED
```
Every transition: structured log + metric + (for security-relevant ones) audit event.

## 7. Cross-cutting concerns

| Concern | Mechanism |
|---|---|
| Correlation | `traceparent` (W3C) propagated browser → control plane → broker; `x-request-id` echo |
| Errors | Typed error codes (05_API_CONTRACTS §3); RFC 9457 problem+json bodies |
| Config | 12-factor env vars validated by Zod at startup; fail fast on invalid config |
| Feature flags | Config-driven (`FEATURE_PORT_FORWARD=false`); production profile locks dangerous flags off |
| Time | All timestamps UTC `timestamptz`; server time authoritative for expiry |
| IDs | UUIDv7 (sortable) internally; prefixed public IDs optional (`ws_…`, `tg_…`, `ss_…`) |
| Limits | Request body 1 MB (API), WS frame 64 KB, file read 10 MB (configurable), rate limits per user |
| Shutdown | SIGTERM → stop accepting → drain sessions (configurable grace, e.g. 30 s) → exit |

## 8. Scaling model

- **Control plane**: stateless; HPA on CPU/RPS. Router keeps WS connections; use ≥3 replicas and
  connection draining on deploy.
- **Broker**: holds live SSH sessions. Sessions are pinned to a broker replica; the session record
  stores `brokerInstanceId`; ingress routes `/api/v1/sessions/{id}/stream` via consistent hashing on
  session ID or the control plane returns a replica-specific stream URL. On broker restart, sessions are
  CLOSED with reason `BROKER_RESTART`, users reconnect.
- **Runtimes**: one pod per running workspace; scheduling capacity is the main cost driver; idle
  shutdown and quotas control spend.

## 9. Deployment topologies

| Topology | Use | Components |
|---|---|---|
| **Dev laptop** | Engineers building the product | docker compose: postgres, control-plane, broker, 1 runtime, mock OIDC (Keycloak/dex), test SSH server |
| **Local Web (end user)** | Single user without cluster | 1 container: runtime image + embedded broker, no control plane; or compose with control plane in "single-user" profile |
| **Desktop (end user)** | Native app | Electron installer; optional hosted control plane URL |
| **Hosted (dev/stage/prod)** | Team use | Kubernetes + managed PG + Vault + OTel |
