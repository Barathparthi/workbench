# QE Workspace — Project Brief

One managed development environment for QE engineers. It works in the browser or as a desktop app, and
gives controlled, audited access to lab machines.

Started 17 Oct 2026 · Status as of 28 Oct 2026 · Current work: Phase 10 of 20

---

## The problem today

QE engineers mostly develop in VS Code on their own laptops. That causes four problems:

- Every laptop has a different toolchain: Python, Java and Node versions and test-framework setup all drift.
- Onboarding a new engineer takes days of local setup.
- Lab machines, test VMs and devices under test are reached with personal SSH keys copied onto laptops.
- Nobody can see who connected to which lab system, or when.

## What QE Workspace does

| Capability             | What it means                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Same IDE everywhere    | A VS Code-style editor with explorer, search, Git and extensions. It works in a browser and as a desktop app.                   |
| Ready-made workspaces  | Pick a template such as "Python pytest" and a Git repo. You get a standard environment with a terminal, and no local setup.     |
| Controlled lab access  | Open a terminal on an approved lab host, or edit its files from the IDE. SSH keys never reach the engineer's browser or laptop. |
| Test runs with results | Run pytest or JUnit and see live output, parsed pass/fail results and saved artifacts.                                          |
| Enterprise controls    | Company sign-in (SSO), role-based permissions, central secrets, an audit trail of every connection, and monitoring.             |
| Visibility for admins  | Lab admins register hosts, decide who may connect and see a record of each session.                                             |

## Three ways to use it

All three modes share the same interface, extensions and way of connecting to lab hosts. Only where the code
runs changes.

| Mode       | Who it suits                                                | Where the code runs                                           |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Hosted web | Everyone, from any browser                                  | A managed, isolated workspace container on company Kubernetes |
| Local web  | Engineers who want it on their own machine in a browser tab | The engineer's machine, opened at localhost                   |
| Desktop    | Engineers who prefer an installed app                       | The engineer's machine, as an Electron app                    |

## How it fits together

```text
  Engineer                  Trusted backend                     Where work happens
 ┌──────────────┐        ┌───────────────────────────┐        ┌──────────────────────────┐
 │ Browser      │        │ Control plane             │        │ Workspaces               │
 │ (hosted or   │ ─────▶ │ sign-in, permissions,     │ ─────▶ │ one isolated container   │
 │  local web)  │        │ policy, audit log         │        │ per workspace            │
 │              │        │                           │        │                          │
 │ Desktop app  │        │ Connection broker         │        │ Registered lab hosts     │
 │ (Win/mac/    │        │ holds SSH credentials,    │        │ Linux/Windows servers,   │
 │  Linux)      │        │ verifies host identity    │        │ VMs, test devices        │
 └──────────────┘        └───────────────────────────┘        └──────────────────────────┘
```

It is built on Eclipse Theia, an open-source IDE platform that looks and works like VS Code and runs in both
the browser and the desktop from one codebase. The backend is TypeScript on Node.js with PostgreSQL.

## Why it is safe

The design rule is that the platform must never become a way to reach machines it shouldn't. Three rules hold
in every phase:

1. **The browser is only a display.** Processes, files, SSH connections, secrets and policy decisions all run
   on trusted backend servers, or on the engineer's own machine in desktop mode.
2. **Only approved hosts, only approved people.** Hosted connections go only to registered hosts, and only
   after permission and policy checks, a check that blocks reaching internal addresses that aren't allowed,
   and verification of the host's identity. If any check fails, the connection is refused.
3. **Credentials and content stay out of logs.** Keys, passwords and tokens are never sent to the browser or
   written to logs, and neither are terminal output or file contents. Every privileged action writes an
   audit event.

## Progress

The work is split into 20 phases. Each phase ends with a gate: tests, security checks and recorded evidence.
Phases 00–09 are in place, and Phase 10 is underway.

| Phase | Name                                | State                                           |
| ----- | ----------------------------------- | ----------------------------------------------- |
| 00    | Environment, decisions & spikes     | Done, gate conditional (waiting on org answers) |
| 01    | Monorepo foundation                 | Done, gate passed                               |
| 02    | IDE shell, browser + desktop        | Done, gate conditional (needs extension mirror) |
| 03    | Control plane & database            | Done, gate passed                               |
| 04    | Identity & permissions              | Done, gate passed                               |
| 05    | Workspace runtime & routing         | Done                                            |
| 06    | Integrated terminal                 | Done                                            |
| 07    | Lab host registry & policy          | Done, gate passed                               |
| 08    | SSH broker & remote terminal        | Done, gate passed                               |
| 09    | Remote file editing                 | Built, gate passed (merge pending CI)           |
| 10    | Local desktop & local web           | **In progress**                                 |
| 11    | QE test runner & reports            | Not started                                     |
| 12    | Company SSO, secrets & audit        | Not started                                     |
| 13    | Monitoring                          | Not started                                     |
| 14    | Security hardening                  | Not started                                     |
| 15    | Release pipeline & supply chain     | Not started                                     |
| 16    | Production Kubernetes               | Not started                                     |
| 17    | Performance, reliability & recovery | Not started                                     |
| 18    | Pilot, release & rollout            | Not started                                     |
| 19    | Advanced remote (optional)          | Not started                                     |

### Demo milestones

| Milestone | What it shows                                                        | State                       |
| --------- | -------------------------------------------------------------------- | --------------------------- |
| M1        | Browser → managed workspace → terminal with live output              | Built; full Docker run open |
| M2        | Browser → registered lab host → SSH terminal and remote file edit    | **Met 27 Oct 2026**         |
| M3        | Desktop and web → same project → QE test run with results and report | Phase 11                    |
| M4        | SSO, permissions, audit and monitoring on hardened Kubernetes        | Phase 16                    |
| M5        | Production pilot, then general availability                          | Phase 18                    |

## Decisions that need an owner

The build can continue without these answers, using stand-ins, but production rollout needs them. Each one
belongs to a team outside the project.

| Decision                         | What is needed                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture and security review | A review with the tech lead and security of the design so far, before the platform goes beyond development.                                                                      |
| Internal extension mirror        | The URL of an internal Open VSX mirror for approved VS Code extensions. Builds use the public registry with pinned, hash-checked versions until then.                            |
| Extension licence review         | Legal and a QE representative need to sign off on the proposed extensions for Python, Java, YAML and Robot Framework.                                                            |
| Hosted address and certificates  | The company DNS name and TLS certificates for the hosted service.                                                                                                                |
| Build network access             | Which package registries and mirrors CI is allowed to reach through the corporate proxy.                                                                                         |
| AI features in the IDE           | Whether the IDE platform's built-in AI features stay, are turned off, or are allowed with an approved provider. Today no AI provider is configured and no data is sent anywhere. |
| A second reviewer                | A second maintainer, so every change can get a review before it merges.                                                                                                          |

---

Sources: the product requirements and executive summary in the project kit, the project log
([`PROJECT_LOG.md`](PROJECT_LOG.md)) and the org decisions register ([`ORG_DECISIONS.md`](ORG_DECISIONS.md)).
