# 01 — Executive Summary

## The ask

Build **QE Workspace**, an internal QE development product that:

- gives a **VS Code-like editor + integrated terminal in the browser**, so engineers do not depend on a
  locally configured VS Code;
- **also works locally** (desktop app or local web) with the *same* experience;
- can **connect to other systems** (lab hosts, VMs, DUTs, Windows/Linux servers) over **SSH** for remote
  terminals and remote file editing;
- is **production grade**: SSO, RBAC, secrets management, audit, observability, hardened deployment,
  CI/CD, tested failure modes, runbooks.

## The answer in one picture

```text
          ┌──────────────── Clients (same Theia extensions) ────────────────┐
          │  Browser (Hosted Web)   Browser (Local Web)   Desktop (Electron) │
          └───────────┬───────────────────┬──────────────────────┬──────────┘
                HTTPS/WSS           http://localhost         in-process IPC
                      │                   │                      │
            ┌─────────▼─────────┐  ┌──────▼───────┐       ┌──────▼────────┐
            │ Gateway + Control │  │ Local runtime│       │ Local backend │
            │ Plane (API, RBAC, │  │ (Docker)     │       │ (Node, PTY,   │
            │ policy, audit)    │  │ + embedded   │       │  FS, embedded │
            └───┬─────────┬─────┘  │ broker       │       │  broker)      │
                │         │        └──────┬───────┘       └──────┬────────┘
     ┌──────────▼──┐  ┌───▼───────────┐   │ SSH                  │ SSH
     │ Workspace   │  │ Connection    │   │                      │
     │ runtimes    │  │ Broker (SSH,  │───┴──────────┬───────────┘
     │ (K8s pods,  │  │ SFTP, host-key│              │
     │ Theia+PTY)  │  │ verification) │      ┌───────▼────────┐
     └─────────────┘  └───────┬───────┘      │ Remote systems │
                              └──────────────▶ Linux/Win/DUT  │
                                             └────────────────┘
```

## Key technology choices

| Concern | Choice | Why |
|---|---|---|
| IDE platform | **Eclipse Theia** | Open-source VS Code-like platform built for browser **and** desktop from one codebase; runs VS Code extensions (Open VSX) |
| Editor | Monaco (inside Theia) | Same editor as VS Code |
| Terminal | xterm.js (frontend) + node-pty (backend) | Theia's built-in stack; industry standard |
| Remote connection | SSH via `ssh2` behind an internal `SshTransport` adapter | Mature Node SSH client with PTY, exec, SFTP, jump-host support |
| Backend language | TypeScript on Node.js LTS | One language across IDE, backend and broker |
| API | Fastify + Zod + OpenAPI | Fast, typed, schema-first |
| Database | PostgreSQL | Metadata, sessions, audit |
| Identity | Company OIDC (SSO) | No second password system |
| Secrets | Vault / cloud secret manager behind `SecretProvider` | SSH credentials never in DB or browser; short-lived SSH certificates preferred |
| Telemetry | OpenTelemetry | Vendor-neutral traces/metrics/logs |
| Packaging | Docker images, Electron installers, Helm charts | Local + hosted from the same artifacts |
| Orchestration | Kubernetes (hosted mode) | Per-user isolation, quotas, scaling |

## Delivery plan

- **20 phases** (00–19), each with goal, prerequisites, numbered steps, code skeletons, tests and an exit gate.
- **5 demoable milestones** (M1–M5), first one after ~3–4 weeks.
- Estimated **20–26 weeks** for a 5–7 person team to a production pilot (see `07_PLANNING/`).

## Biggest risks (and how the plan handles them)

| Risk | Mitigation |
|---|---|
| Platform becomes a remote-code-execution / lateral-movement tool | Registered targets only, policy before network, host-key pinning, SSRF guard, egress NetworkPolicies, audit |
| SSH keys leak | Keys never leave the backend; prefer short-lived Vault-signed SSH certificates |
| Browser and desktop drift apart | Shared extension packages + parity test suite run against both targets in CI |
| Theia upgrade churn | Pin versions, monthly upgrade cadence, contract tests around our extensions |
| Workspace cost/scale | Idle shutdown, quotas, persistent volumes, load tests before GA |

## What "done" looks like

A QE engineer signs in with SSO (or opens the desktop app), opens a project, edits a test, runs it in the
integrated terminal with live output, connects to an approved lab host, edits a file there, runs a remote
command, disconnects — and an admin can see the audited session events. No credential ever reaches the
browser, and the whole flow is monitored, tested and deployable by pipeline.
