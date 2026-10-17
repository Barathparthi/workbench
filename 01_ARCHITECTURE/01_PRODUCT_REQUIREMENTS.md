# 01 — Product Requirements (PRD) and Non-Functional Requirements

## 1. Problem statement

QE engineers develop mostly in VS Code on their own laptops. Toolchains drift, onboarding is slow, lab
access relies on personal SSH keys spread across laptops, and there is no central visibility into who
accessed which system. The team needs a **centrally managed development workbench** usable from a
**browser** *and* **locally**, with the **same** VS Code-like experience and **controlled remote
connections** to other systems.

## 2. Goals and non-goals

### Goals
- G1. VS Code-like editing (Monaco, explorer, search, SCM, extensions) in browser and desktop.
- G2. Integrated interactive terminal running in the workspace's runtime.
- G3. Brokered SSH connections to registered remote systems: terminal + file editing.
- G4. Same workspace model, extensions and connection UX in Hosted Web, Local Web and Desktop.
- G5. First-class QE test execution with live output, parsed results and artifacts.
- G6. Enterprise controls: SSO, RBAC, secrets management, audit, observability.
- G7. Production operations: CI/CD, hardened Kubernetes, backups, runbooks, SLOs.

### Non-goals (first release)
- Public/multi-customer hosting.
- An open SSH proxy to arbitrary hosts.
- Unrestricted port forwarding / SOCKS proxy.
- Automatic network discovery of machines.
- Full public extension marketplace (only allowlisted Open VSX mirror).
- RDP/VNC/serial console (candidates for later; see Phase 19).
- Replacing the CI system — the runner is for developer-loop execution.

## 3. Personas

| Persona | Needs |
|---|---|
| **QE engineer (Priya)** | Open repo fast, run pytest, debug, SSH to lab VM, edit config there, no local setup |
| **SDET lead (Arun)** | Standard toolchain for the team, share workspace templates, see test results |
| **Lab admin (Meera)** | Register lab hosts, decide who may connect, rotate credentials, see audit |
| **Platform engineer (Dev)** | Deploy, scale, monitor, upgrade, recover |
| **Security reviewer (Sam)** | Evidence that access is controlled, credentials safe, actions audited |

## 4. User stories with acceptance criteria

### 4.1 Access & workspaces
| ID | Story | Acceptance |
|---|---|---|
| US-01 | As an engineer I sign in with company SSO | Redirect to IdP, back to workspace list; no local password |
| US-02 | I see only workspaces I'm a member of | API returns only member workspaces; direct GET of others → 403/404 |
| US-03 | I create a workspace from a template (e.g. "Python pytest") and a Git URL | Workspace READY with repo cloned in ≤ 90 s p95 (warm image) |
| US-04 | I reopen my workspace and find files, settings, terminal history (scrollback optional) intact | Files persisted on volume; settings persisted |
| US-05 | My idle workspace stops automatically and resumes on next open | Idle stop after N min; resume ≤ 30 s p95 |

### 4.2 Editing & execution
| ID | Story | Acceptance |
|---|---|---|
| US-10 | Edit with syntax highlighting, IntelliSense (via extensions), search, Git | Python/Java LSP features work in managed workspace |
| US-11 | Open multiple integrated terminals | Interactive programs (vim, top, python REPL) work; resize works |
| US-12 | Stop a long process with Ctrl+C | SIGINT delivered within 1 s |
| US-13 | See exit code and duration of task runs | Shown in task/runner UI |

### 4.3 Remote systems
| ID | Story | Acceptance |
|---|---|---|
| US-20 | I pick a lab host from "Remote Connections" | Only targets I'm authorized for are listed |
| US-21 | I open a remote terminal on that host | Host key verified; shell opens ≤ 3 s p95; no key in browser |
| US-22 | I browse/edit/save files under the target's project root | Save acknowledged ≤ 1 s p95; cannot escape root |
| US-23 | I disconnect, or my session expires | Remote channel closed; audit event written |
| US-24 | (Admin) I register a target with host, port, auth method, host-key fingerprint, root, policy | Validated; SSRF rules applied; audit event |
| US-25 | (Admin) I revoke a user's live sessions | All their sessions closed ≤ 10 s |
| US-26 | (Desktop) I connect to a personal host from my `~/.ssh/config` | Works with my ssh-agent; host key checked against my `known_hosts` |

### 4.4 QE workflows
| ID | Story | Acceptance |
|---|---|---|
| US-30 | Run a test suite / single test from the QE panel | Live output; status; can cancel |
| US-31 | See parsed results (pass/fail/skip, failures with messages) | From JUnit XML; click-through to file:line |
| US-32 | Open HTML report / download artifacts | Artifact links scoped to workspace |
| US-33 | Run tests on a remote target | Same UI, executes via broker `exec`, results collected |

### 4.5 Admin & audit
| ID | Story | Acceptance |
|---|---|---|
| US-40 | (Admin/Auditor) query audit events by user/target/time | Filterable, paginated, export CSV |
| US-41 | (Platform) see dashboards and get alerts | Dashboards for health, sessions, SSH, runner |

## 5. Non-functional requirements

### 5.1 Performance (starting SLOs — validate in Phase 17)

| Capability | Target |
|---|---|
| Authenticated load → usable IDE shell (warm runtime) | p95 < 5 s |
| Workspace cold start (image cached) | p95 < 60 s |
| Workspace resume from stopped | p95 < 30 s |
| Terminal open (local runtime) | p95 < 1.5 s |
| Remote SSH terminal open | p95 < 3 s |
| Keystroke echo latency (same region) | p95 < 100 ms |
| File tree initial load (5k files, managed) | p95 < 3 s |
| Remote file save ack | p95 < 1 s |
| API (metadata) | p95 < 300 ms |

### 5.2 Scale
- 150 registered users, 60 concurrent workspaces, 300 concurrent terminals, 100 concurrent SSH sessions
  at GA (adjust from A2/A3). Architecture must scale horizontally beyond this without redesign.

### 5.3 Availability & durability
- Control plane 99.9% (business hours) at GA; graceful degradation: running terminals survive control-plane restarts.
- Workspace volumes: daily snapshots (RPO 24 h), restore procedure tested (RTO 4 h).
- Zero-downtime deploys for control plane and broker; workspace runtimes upgraded on next restart.

### 5.4 Security
- OIDC SSO in hosted mode; desktop uses OIDC + PKCE for managed features.
- Server-side authorization on every privileged operation.
- No SSH private key/password in browser, DB plaintext, logs or telemetry.
- Host-key verification mandatory; unknown keys follow enrollment workflow.
- Workspace isolation: separate pod, non-root, PSS Restricted, NetworkPolicy, quotas.
- Audit for every privileged action; tamper-evident storage.

### 5.5 Usability & compatibility
- Browsers: current Chrome, Edge, Firefox (latest two versions); Safari best effort.
- Keyboard shortcuts compatible with VS Code defaults.
- Accessibility: Theia/Monaco defaults + our panels meet WCAG 2.1 AA for contrast and keyboard nav.

### 5.6 Operability
- Structured JSON logs, OpenTelemetry traces & metrics, dashboards, alerts with runbooks.
- Health (`/healthz`), readiness (`/readyz`) and version (`/version`) endpoints on every service.

## 6. Release acceptance statement

The first production release is accepted when a QE engineer can authenticate, open a managed workspace,
edit a real automation repository, run its tests with live output and parsed results, connect to an
approved SSH target, edit and run something there, disconnect — in **both browser and desktop** — and the
platform shows auditable session events, with no credential exposed, all release gates in
`04_OPERATIONS/PRODUCTION_READINESS_CHECKLIST.md` passed.
