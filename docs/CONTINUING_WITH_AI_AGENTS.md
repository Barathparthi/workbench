# Continuing QE Workspace with AI Coding Agents

How to carry on building QE Workspace with an AI coding agent — **Claude Code**, **OpenAI Codex CLI**, **OpenCode**,
**Codebuff / Freebuff**, or any other — so that each one picks up exactly where the last one stopped, follows the same
rules and produces the same quality of work.

Read it once completely. Afterwards, sections 4 (prompts) and 8 (checklist) are what you need day to day.

**Contents**

1. [Where the project stands (2026-11-01)](#1-where-the-project-stands-2026-11-01)
2. [What is left, in order](#2-what-is-left-in-order)
3. [Setting up each agent](#3-setting-up-each-agent)
4. [Prompts to copy and paste](#4-prompts-to-copy-and-paste)
5. [The workflow every phase follows](#5-the-workflow-every-phase-follows)
6. [The machine: what runs where](#6-the-machine-what-runs-where)
7. [Lessons learned — read before you start](#7-lessons-learned--read-before-you-start)
8. [Handing over between agents: checklist](#8-handing-over-between-agents-checklist)
9. [Keeping agents safe on this repository](#9-keeping-agents-safe-on-this-repository)

---

## 1. Where the project stands (2026-11-01)

The live record is [`PROJECT_LOG.md`](PROJECT_LOG.md); this is the summary at hand-over time.

| Phase                                | State                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| 00 Environment, decisions, spikes    | Gate CONDITIONAL (org answers, architecture review)                                         |
| 01–09                                | Done (02 CONDITIONAL on the internal Open VSX mirror, D7)                                   |
| 10 Local desktop and local web       | 10a PASS, 10b CONDITIONAL (D15 signing, D16 package identity, D17 updates, D9, desktop run) |
| 11 QE test runner and reports        | **PASS** — milestone **M3** met                                                             |
| 12 Enterprise SSO, secrets and audit | **Deferred to the end** (owner's decision 2026-11-01)                                       |
| 13–19                                | Not started                                                                                 |

**Git:**

- Branches are stacked: `phase-09-remote-fs` (merged) → `phase-10-local-desktop` → `phase-11-qe-runner`. The owner
  opens and merges the PRs in that order. Start the next phase **from `phase-11-qe-runner`** until it is merged, then
  from `main`.
- Latest commits are on `phase-11-qe-runner` on GitHub (`github.com/Barathparthi/workbench`).

**Open follow-ups from Phase 11** (also in the log's next actions):

- No parity/E2E scenario runs tests **on a remote system** from the QE Tests panel; it was rehearsed by hand on
  2026-11-01 (green in hosted and local web). Add it to `tests/parity/parity.spec.ts` early in Phase 13 or 14.
- In local web, when a page closes after a remote run, the backend logs an uncaught `transport close` (engine.io).
  Harmless so far; find which RPC call is left unhandled.

**Org decisions waiting on people, not code:** B1 (corporate IdP), D7 (Open VSX mirror), D9 (hosted DNS and
certificate), D15–D17 (desktop signing, identity, updates), D18 (test-report storage), D19 (Maven source). See
[`ORG_DECISIONS.md`](ORG_DECISIONS.md). An agent must **stop and ask** when a step needs one of them.

**Useful documents:** [`GETTING_STARTED.md`](GETTING_STARTED.md) (using the product), [`DEMO_GUIDE.md`](DEMO_GUIDE.md)
(showing it), [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md) (developing it), the gate records in
[`phase-gates/`](phase-gates/).

---

## 2. What is left, in order

Phase 12 goes last by the owner's decision, so the order is:

| #   | Phase                                    | Goal                                                                                                | Can be done locally?                                                                                        | Needs from people                                                                                    |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | **13 Observability**                     | On-call can tell whether a failure is in the control plane, runtime, broker, target or test process | Yes — OTel collector, Prometheus, Grafana and Jaeger in Docker Compose stand in for the org's backend (D10) | Approval of the new pinned `@opentelemetry/*` dependencies; synthetic checks in staging wait for one |
| 2   | **14 Security hardening**                | Every threat T1–T23 has a control, an automated test, evidence and an owner                         | Mostly — threat register, gap tests, HTTP/WS hardening, rate limits, input limits, container scans          | A security reviewer for the walk-through and sign-off; DAST/pen test; credential threats wait for 12 |
| 3   | **15 CI/CD and supply chain**            | Reproducible, scanned, signed, SBOM'd releases promoted dev → staging → prod                        | Partly — SHA-pinned actions, multi-stage images, Trivy, Syft SBOM, cosign in CI                             | D6 (registry and signing), cluster access for deploys                                                |
| 4   | 19 Advanced remote (optional)            | Remote agent mode, governed port forwarding, jump hosts, step-up auth, session recording            | Yes, item by item                                                                                           | Owner picks which items                                                                              |
| 5   | **12 Enterprise SSO, secrets and audit** | Corporate OIDC, Vault `SecretProvider`, short-lived SSH certificates, audit viewer and coverage     | Mostly — Keycloak + a Vault dev container                                                                   | B1 (IdP), D5 (Vault), the `ssh2` certificate patch decision (patch-package vs fork, ADR), staging    |
| 6   | 16 Kubernetes production                 | Hardened Helm deployment (milestone M4)                                                             | Partly (kind/k3d)                                                                                           | D1–D3 (cluster, ingress, storage)                                                                    |
| 7   | 17 Performance, reliability, DR          | SLOs under load, failure injection, backup and restore                                              | No — needs staging                                                                                          | Staging environment                                                                                  |
| 8   | 18 Pilot, release, rollout               | Pilot group → GA (milestone M5)                                                                     | No                                                                                                          | Pilot users, stakeholders                                                                            |

Each phase has a guide (`02_PHASES/PHASE_xx_*.md`) and a prompt pack (`03_PROMPTS/PHASE_xx_PROMPTS.md`) — the agent
follows both.

---

## 3. Setting up each agent

### 3.1 What every agent needs to know, and where it reads it

| Agent               | Reads automatically     | Notes                                                                                      |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code         | `CLAUDE.md`             | Its auto-memory lives on one machine only; everything important is also in this repository |
| OpenAI Codex CLI    | `AGENTS.md`             |                                                                                            |
| OpenCode            | `AGENTS.md`             | Do **not** run its `/init`: it would rewrite `AGENTS.md`                                   |
| Codebuff / Freebuff | Its own knowledge files | Tell it to read `AGENTS.md` (the start prompt in 4.1 does)                                 |
| Anything else       | Varies                  | The start prompt in 4.1 works with any agent                                               |

`CLAUDE.md` and `AGENTS.md` carry the same rules. If you change one, change the other. `CLAUDE.md` wins if they differ.

### 3.2 Where to run the agent

Run it **inside WSL Ubuntu, in `~/src/workbench`** — that is where the project builds and runs (section 6). Install
Node 24.22.0 there first (`nvm use` in the repository). A Windows-side agent can only edit and run typecheck, lint
and unit tests on `D:\workbench`, and then needs the changes moved over (section 6.2).

### 3.3 Installing

Install commands change; if one fails, use the tool's own website.

| Agent               | Install (in WSL)                                                                                  | Start in the repository    |
| ------------------- | ------------------------------------------------------------------------------------------------- | -------------------------- |
| Claude Code         | `curl -fsSL https://claude.ai/install.sh \| bash` (or `npm install -g @anthropic-ai/claude-code`) | `claude`                   |
| OpenAI Codex CLI    | `npm install -g @openai/codex`                                                                    | `codex`                    |
| OpenCode            | `curl -fsSL https://opencode.ai/install \| bash` (or `npm install -g opencode-ai`)                | `opencode`                 |
| Codebuff / Freebuff | From the tool's website (`npm install -g codebuff` for Codebuff)                                  | `codebuff` / as documented |

Each asks you to sign in on first start. Never paste API keys, GitHub tokens or passwords into the chat.

### 3.4 Permission settings

Choose the mode in which the agent **asks before running commands and before editing**, at least for the first
sessions:

- Claude Code: default mode asks; `Shift+Tab` switches to plan mode (no edits) for inspect and plan steps.
- Codex CLI: an approval mode that asks before commands (see `/approvals` or `codex --help`).
- OpenCode / Codebuff / Freebuff: their "ask before running" or plan setting.

Never allow, without reading: `git push --force`, `git reset --hard`, `rm -rf` outside `/tmp`, `docker compose … down
-v` (deletes the database), `npm audit fix --force`, anything with `sudo`.

---

## 4. Prompts to copy and paste

### 4.1 Start of every session (any agent)

```text
You are continuing QE Workspace, a production-grade IDE platform. Before doing anything, read in full:
AGENTS.md, CLAUDE.md, docs/PROJECT_LOG.md (status snapshot and next actions), docs/CONTINUING_WITH_AI_AGENTS.md,
and the gate record of the last finished phase (docs/phase-gates/PHASE_11.md).

Rules that override your defaults:
- Follow the non-negotiable rules in CLAUDE.md exactly. Never weaken or skip a test or security check.
- Inspect and plan steps make NO edits. I approve the plan before any implementation.
- One small commit per step, Conventional Commits, and NO Co-Authored-By or other attribution lines.
- Report real command output only. If a step needs an org decision or an API you are unsure of, stop and ask me.
- Builds, Docker, integration and E2E tests run in WSL in ~/src/workbench (see section 6 of the continuing guide).

Then tell me in 5 lines: the current phase, the branch, what is open, and what you propose to do first.
```

### 4.2 Start a phase (example: Phase 13)

```text
Start Phase 13 (Observability). Read 02_PHASES/PHASE_13_OBSERVABILITY.md, 03_PROMPTS/PHASE_13_PROMPTS.md,
01_ARCHITECTURE/10_OBSERVABILITY.md and 03_PROMPTS/01_STANDARD_8_STEP_LOOP.md.
Create the branch phase-13-observability from phase-11-qe-runner (or from main once Phase 11 is merged).
Run [LOOP-1] Inspect and [LOOP-2] Plan from the loop file. Do not edit files.
In the plan, list every new third-party dependency with its exact version, every org decision it touches, and
the steps in order, each small enough for one commit with a green build.
```

### 4.3 Implement after approval

```text
The plan is approved [with these changes: …]. Implement step <N> only ([LOOP-3]).
Run typecheck, lint, format check and the unit tests of the touched packages; integration tests if you touched a
boundary. Show the real output. Commit with a plain Conventional Commit message. Then stop and wait.
```

### 4.4 Review, validate, document, gate

```text
All steps of Phase <N> are implemented. Run [LOOP-4] Review over the whole phase diff (security first: the CLAUDE.md
rules and the threat IDs), then [LOOP-5] fix what you find with tests. Then [LOOP-6] Validate: the full unit,
integration and Playwright suites in WSL against a freshly built stack (section 6.4 of the continuing guide), real
output. Then [LOOP-7] Document (PROJECT_LOG, CHANGELOG) and [LOOP-8] write docs/phase-gates/PHASE_<N>.md from
06_TEMPLATES/PHASE_GATE_TEMPLATE.md in the same format as PHASE_11.md, with a PASS / CONDITIONAL / FAIL proposal.
```

### 4.5 Resume after a break or a different agent

```text
Read docs/PROJECT_LOG.md and `git log --oneline -15` on the current branch, and `git status`.
Tell me which step of which phase was last finished, whether anything is uncommitted, and what the next step is.
Do not change anything yet.
```

### 4.6 A failing CI run

```text
CI failed on <branch>. Get the failing job's log (gh run view --log-failed), find the root cause, and reproduce it
locally. Fix the cause, never by skipping, loosening or deleting a test. Show the before and after output.
```

---

## 5. The workflow every phase follows

From `03_PROMPTS/01_STANDARD_8_STEP_LOOP.md`, as practised in Phases 01–11:

1. **Inspect** (no edits) — what exists, what the guide asks for, which org decisions are missing.
2. **Plan** (no code) — ordered steps, threats, tests, docs. **You approve.** Decisions you make go into the log.
3. **Implement** — one step per commit, tests (positive and negative) in the same commit, green typecheck/lint/unit.
4. **Review** — the whole phase diff, security first.
5. **Fix** — every finding with a regression test.
6. **Validate** — everything, in WSL, on a fresh build: unit, integration, all Playwright projects (section 6.4).
7. **Document** — `docs/PROJECT_LOG.md` entry and status snapshot, `CHANGELOG.md` under `[Unreleased]`,
   `docs/ORG_DECISIONS.md` for new open decisions, user docs if behaviour changed (`GETTING_STARTED.md`).
8. **Gate** — `docs/phase-gates/PHASE_xx.md`: deliverables, real validation output, defects found, security review,
   operational review, parity, deviations, limitations, decision.

Then push the branch; you open the PR with `.github/pull_request_template.md`. A new architecture decision or a
changed package boundary gets an ADR in `05_ADR/`.

---

## 6. The machine: what runs where

### 6.1 Two copies of the repository

| Copy                     | Used for                                                                                   | Cannot                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `D:\workbench` (Windows) | Editing, `npm run typecheck`, `npm run lint`, `npm run format:check`, unit tests, git push | Build the IDE (no C++ toolchain), Docker |
| `~/src/workbench` (WSL)  | Everything: builds, Docker, the dev stack, integration and Playwright tests                | —                                        |

Working only in WSL is simplest for an agent. If you edit on Windows, move the commits over before WSL runs:

### 6.2 Syncing Windows → WSL

```bash
cd ~/src/workbench
git fetch /mnt/d/workbench <branch> && git checkout -B <branch> FETCH_HEAD
```

### 6.3 Company proxy (Netskope)

- WSL trusts the proxy's CA: `/usr/local/share/ca-certificates/netskope-ca.crt`, with
  `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` (or that file) in `~/.bashrc`.
- Docker image builds need `--secret id=extra_ca,src=/usr/local/share/ca-certificates/netskope-ca.crt`.
- Long downloads get dropped (`ETIMEDOUT`, `ECONNRESET`): retry. The runtime image retries npm downloads itself, but
  a full image build still sometimes needs a second or third attempt.

### 6.4 The development stack (as used for every gate)

| Piece                   | How                                                                                                     | Where                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| PostgreSQL + Keycloak   | `docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait` (not restarted after a reboot)   | :5432, :8081                              |
| Connection broker       | `npm run dev -w @qe/connection-broker` (`apps/connection-broker/.env`)                                  | :8082                                     |
| Control plane           | `npm run dev -w @qe/control-plane` (migrates first; `apps/control-plane/.env`)                          | :8080                                     |
| Workspace runtime image | `docker build -f images/workspace-runtime/Dockerfile … -t qews/runtime:dev .`                           | hosted workspaces                         |
| Hosted workspace        | `demo`, id `01a1778e-d4f7-73d7-b956-9aa3d9af46b1`, container `qews-ws-<id>`                             | `http://localhost:8080/w/<id>/`           |
| Lab machine             | container `qews-lab-a`, image **`qews-lab-openssh:dev`**, network `qews-lab`, IP 172.30.0.10, user `qe` | target `lab-a-dev`, personal host `lab-a` |

Control-plane `.env` essentials: `AUTH_MODE=dev`, `DEV_ROLES=qe.admin,qe.user,lab.a.user`,
`ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8080`, `BROKER_INTERNAL_URL`, `BROKER_PUBLIC_URL`, and the same
`INTERNAL_SERVICE_TOKEN` as the broker. The lab policy `lab-a-dev` allows 172.30.0.0/24, port 22, role `lab.a.user`,
capabilities `terminal`, `file_read`, `file_write`, `exec`; its host key is
`SHA256:OllhDjWvCr/L2LwG0G/EsTMm1eUwF6P7NtCWOyA0tMo`.

**A full gate run** (what Phase 11 did, in one script):

1. sync the branch; `npm ci`; build broker, control plane, `-w extensions`, `@qe/ide-browser`, `@qe/ide-electron`;
2. compose up; `docker start qews-lab-a`;
3. stop whatever holds :8082 and :8080, start the broker, run `dist/db/migrate-cli.js`, start the control plane, wait
   for both `/readyz`;
4. rebuild the runtime image; stop the workspace, `docker rm -f qews-ws-<id>`, start it, clear
   `/home/qe/.theia/workspaces` in it;
5. Playwright projects, with
   `QE_E2E_HOME=$HOME/.cache/qe-e2e-home QE_E2E_PERSONAL_HOST=lab-a QE_E2E_HOSTED_URL=http://localhost:8080/w/<id>/
QE_E2E_HOSTED_CONTAINER=qews-ws-<id>`: `hosted` (twice), `parity-hosted`, `browser`, `local-web-security`,
   `electron`, `parity-local-web`, `parity-desktop` (under `xvfb-run -a`);
6. `npx vitest run --project integration`, then `--project unit`.

Expected at Phase 11: hosted 3, parity-hosted 8 + 1 skipped (webview, D9), browser 23, local-web-security 6,
electron 4, parity-local-web 10, parity-desktop 9, integration 154 + 1 skipped (real Maven, opt-in), unit 1716 + 2
skipped (Windows-only). Numbers only grow.

---

## 7. Lessons learned — read before you start

Real problems from Phases 08–11; each cost hours once.

| Lesson                                                                                                         | What to do                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests passed while the real stack was broken (first end-to-end run found 3 bugs)                          | Every gate runs the full stack end to end in WSL; a phase is not done on unit tests                                                                |
| Shell heredocs mangle backticks and `$` in TypeScript                                                          | Edit files with the agent's file tools or a small Node script, not `cat <<EOF` into source files                                                   |
| Debian/Ubuntu `sh` is dash: `kill -KILL -- -PGID` fails                                                        | Test shell commands against a real `sh` (dash) and the Alpine lab                                                                                  |
| The lab container was older than its image (no pytest): remote runs failed with exit 127                       | After changing `packages/test-utils/openssh`, rebuild `qews-lab-openssh:dev` and recreate `qews-lab-a` keeping its host keys and `authorized_keys` |
| Testcontainers deletes the `qews-test-openssh` tag after test runs                                             | The lab container uses the tag `qews-lab-openssh:dev`                                                                                              |
| Tests passed only because of state left by earlier tests (a missing `tests/` folder in a fresh hosted project) | Each test creates what it needs; run suites on a fresh workspace before a gate                                                                     |
| Timing waits of 1 s failed on a busy machine                                                                   | Waits on processes get generous timeouts (15 s); never "fix" by deleting the assertion                                                             |
| A killed Playwright run left its web server on :3030                                                           | Before re-running: `ss -ltnp \| grep 3030` and stop that process                                                                                   |
| Hosted terminals outlive pages; after 10 the IDE refuses new ones                                              | Tests close the terminals they open; detached terminals end after 30 min                                                                           |
| A throwaway control plane started via `setsid npm …` left orphans on :8080                                     | Start `node dist/main.js` directly and kill that PID                                                                                               |
| The compose stack does not come back after a WSL restart                                                       | `docker compose … up -d --wait` before the control plane, else `ECONNREFUSED 127.0.0.1:5432`                                                       |
| The runtime image build failed on proxy timeouts                                                               | Retry; check `/tmp/*image*.log` for `ETIMEDOUT` before suspecting the code                                                                         |

---

## 8. Handing over between agents: checklist

Before you stop with one agent:

- [ ] Everything committed (`git status` clean) with plain messages, and pushed.
- [ ] `docs/PROJECT_LOG.md` says what was done, what is half-done and the next step.
- [ ] No processes left running that the next agent will trip over (:3030, :8080, :8082 from scripts).
- [ ] Any decision you made with the agent is written in the log (not only in the chat).

When you start with the next agent:

- [ ] Paste the start prompt (4.1). Check its 5-line summary matches the log before letting it work.
- [ ] Use the resume prompt (4.5) if a phase is half done.
- [ ] Only **one agent works on a branch at a time**.

---

## 9. Keeping agents safe on this repository

- The repository holds development secrets only (`.env.example`, dev keys under `apps/connection-broker/dev-keys`,
  git-ignored). Never let an agent commit `.env` files or keys; check `git status` before every push.
- Agents must never weaken the security controls this product is about: SSRF checks, host-key verification, path
  confinement, `shell: false`, the quoting helper, permissions on routes, audit events. A review that finds such a
  change rejects it.
- Agents never get your GitHub token, Docker Hub or company credentials. Pushes use your cached git credentials; PRs
  and merges are yours.
- Prefer small sessions: one phase step per session keeps context small and output reviewable.
