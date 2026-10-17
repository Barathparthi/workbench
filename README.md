# QE Workspace — Production Implementation Kit (v2)

> A step-by-step, phase-by-phase engineering guide **plus** copy/paste AI prompts for building
> **QE Workspace**: a production-grade, VS Code-like development environment that works the same
> way **in the browser (web)** and **on the developer's machine (local/desktop)**, with an
> integrated terminal, code editor, and **brokered SSH remote connections to other systems**.

---

## 0. This repository: status and quick start

This repository holds the implementation kit (folders `00_…07_`, `reference/`) **and** the product code
built from it. Where things stand, and what was done when, is in **[`docs/PROJECT_LOG.md`](docs/PROJECT_LOG.md)**.

| Phase | State |
|---|---|
| 00 — Environment, decisions & spikes | In progress: toolchain pinned (Theia 1.76.0); spikes S1, S2, S5 done, ADR-005 (path routing) accepted; S3, S4 and org answers pending |
| 01 — Monorepo foundation | Done — gate PASS (CI green on Ubuntu and Windows, branch protection on) |
| 02 — Theia product shell | Next |

Prerequisites: Node.js **24.22.0** (`.nvmrc`; `nvm install`), npm 11, Git. Docker is needed from Phase 03.

```bash
npm ci                 # or scripts/bootstrap.sh  /  scripts/bootstrap.ps1
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run verify         # everything CI runs
```

| Path | What |
|---|---|
| `packages/*` | Library packages (`@qe/domain`, `contracts`, `rbac`, `policy`, `broker-core`, …) |
| `tests/lint/` | Proof that the package-boundary rules hold |
| `docs/` | Project log, org decisions, phase-gate evidence, spike reports |
| `spikes/` | Throwaway Phase 00 spikes (own `package.json`, outside the product build) |
| `CLAUDE.md` / `AGENTS.md` | Rules for coding agents working in this repo |

---

## 1. What problem this solves

Today most QE engineers develop in **VS Code on their own laptop**:

- every laptop has a different toolchain, Python/Java/Node version, and test-framework setup;
- access to lab machines / DUTs / test VMs is done with personal SSH keys stored on laptops;
- onboarding a new engineer takes days;
- nobody can see who connected to which lab system, when.

**QE Workspace** gives the team one product, usable in three ways, with the **same UI, same extensions,
same workspace model and same remote-connection model**:

| Mode | Who uses it | Where code runs | Where the IDE renders |
|---|---|---|---|
| **Hosted Web** | Everyone, from any browser | Managed workspace container (Kubernetes) | Browser over HTTPS/WSS |
| **Local Web** | A developer on their laptop, or a small team server | Docker container on that machine | Browser at `http://localhost` |
| **Desktop** | Developer who wants a native app | The developer's own machine | Electron window |

In every mode the user can:

1. open a project, edit code with a Monaco (VS Code) editor, and use approved VS Code extensions;
2. open an integrated terminal and run programs/tests with live output;
3. **connect to another system** (Linux/Windows lab host, VM, DUT) through **SSH**, get a remote
   terminal and browse/edit remote files;
4. run QE test suites and see structured results and reports;
5. (Hosted) be authenticated by company SSO, authorized by RBAC, and audited.

---

## 2. How this kit is organised

```text
QE-Workspace/
├── README.md                         ← you are here
├── MANIFEST.md                       ← every file, one line each
├── 00_START_HERE/                    ← read first (summary, how to use, decisions, glossary)
├── 01_ARCHITECTURE/                  ← requirements, architecture, contracts, data, security, testing, CI/CD
├── 02_PHASES/                        ← 20 detailed build phases (PHASE_00 … PHASE_19)
├── 03_PROMPTS/                       ← AI prompts: bootstrap, 8-step loop, one prompt pack per phase, utilities
├── 04_OPERATIONS/                    ← runbooks, readiness checklist, acceptance, demo, user/admin guides
├── 05_ADR/                           ← architecture decision records
├── 06_TEMPLATES/                     ← CLAUDE.md/AGENTS.md, PR template, phase gate, ADR template, configs
├── 07_PLANNING/                      ← roadmap, team/RACI, risk register, estimates
└── reference/                        ← original technical architecture (.docx)
```

---

## 3. Start here (in this order)

| # | Read | Why |
|---|---|---|
| 1 | `00_START_HERE/01_EXECUTIVE_SUMMARY.md` | One-page picture of the product and the plan |
| 2 | `00_START_HERE/02_HOW_TO_USE_THIS_KIT.md` | How humans + AI agents use the guides and prompts together |
| 3 | `00_START_HERE/03_DECISIONS_BEFORE_CODING.md` | Questions you **must** answer with your org (SSO, K8s, secrets, network) |
| 4 | `01_ARCHITECTURE/02_SOLUTION_ARCHITECTURE.md` | The design everyone builds against |
| 5 | `01_ARCHITECTURE/09_LOCAL_AND_WEB_PARITY.md` | How "works on both local and web" is guaranteed |
| 6 | `01_ARCHITECTURE/08_REMOTE_CONNECTIVITY_DESIGN.md` | How "connect to other systems" works safely |
| 7 | `02_PHASES/PHASE_00_…` → `PHASE_19_…` | Execute in order |
| 8 | `03_PROMPTS/00_SESSION_BOOTSTRAP_PROMPT.md` + the phase prompt pack | Drive your AI coding agent |

---

## 4. The phase plan at a glance

| Phase | Name | Milestone it unlocks |
|---|---|---|
| 00 | Environment, decisions & spikes | Org inputs captured, toolchain pinned, 3 spikes de-risked |
| 01 | Monorepo foundation | Buildable repo, lint/typecheck/test/CI skeleton |
| 02 | Theia product shell (browser + desktop) | "QE Workspace" IDE opens in browser **and** Electron |
| 03 | Control plane & database | Versioned API, PostgreSQL, migrations, health |
| 04 | Dev identity & RBAC skeleton | Every request has a principal; permission matrix enforced |
| 05 | Workspace runtime & routing | Start/stop isolated workspaces; browser routed to *its* runtime |
| 06 | Integrated terminal hardening | Reliable terminal in runtime: resize, Ctrl+C, limits, cleanup |
| 07 | Remote target registry & policy | Admin registers lab hosts; allow/deny decisions; SSRF guard |
| 08 | SSH broker & remote terminal | **Connect to other systems**: SSH PTY in the IDE |
| 09 | Remote filesystem | Browse/edit/save files on the remote host inside a root |
| 10 | Local desktop & local-web mode | Same product on a laptop; personal + managed targets |
| 11 | QE test runner & reports | Run pytest/JUnit/etc., live output, parsed results, artifacts |
| 12 | Enterprise SSO, secrets & audit | OIDC, Vault/secret manager, short-lived SSH certs, audit trail |
| 13 | Observability | OpenTelemetry traces/metrics/logs, dashboards, alerts |
| 14 | Security hardening | Threat model closed with tests and evidence |
| 15 | CI/CD & supply chain | Signed, scanned, SBOM'd, reproducible releases |
| 16 | Kubernetes production | Hardened Helm deploy, NetworkPolicies, PSS Restricted |
| 17 | Performance, reliability & DR | Load/soak/failure-injection, backup/restore, rollback drill |
| 18 | Pilot, release & rollout | Pilot group, telemetry review, GA |
| 19 | (Optional) Advanced remote | Remote agent mode, jump-host chains, port-forward governance |

Milestones you can demo:

```text
M1 (end of P06): Browser → QE Workspace → managed workspace → terminal → live output
M2 (end of P09): Browser → registered lab host → SSH terminal + remote file edit
M3 (end of P11): Desktop + Web → same project → QE test run → results + report
M4 (end of P16): SSO + RBAC + audit + observability on hardened Kubernetes
M5 (end of P18): Production pilot → general availability
```

---

## 5. The three rules that never bend

1. **The browser is a client, not a trusted computer.** Processes, files, SSH, secrets and policy
   live on trusted backend infrastructure (or on the user's own machine in desktop mode).
2. **No one connects to an arbitrary host.** Hosted/managed connections go only to *registered*
   targets, after *authorization*, *SSRF checks* and *host-key verification*, using credentials
   the browser never sees.
3. **One workspace contract, many clients.** Browser and desktop use the same Theia extensions,
   the same workspace model and the same connection interfaces — only the transport differs.

---

## 6. Definition of done (every phase)

```text
code + tests (positive AND negative) + security controls + telemetry
     + audit (where privileged) + docs + green CI + reproducible demo evidence
     = phase complete  (recorded with 06_TEMPLATES/PHASE_GATE_TEMPLATE.md)
```

---

## 7. Relationship to the v1 kit

This folder supersedes the v1 kit in the parent directory (`00_…10_*.md`, `phases/`, `prompts/`,
`adr/`). Everything from v1 is preserved in substance and expanded with: first-class local/desktop
mode, a deep remote-connectivity design, concrete code/config/SQL skeletons, per-step prompt packs,
operations runbooks, planning material and repo-agent templates.
