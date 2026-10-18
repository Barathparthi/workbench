# Continuing QE Workspace on a Local Machine

This guide moves day-to-day work on QE Workspace from the cloud session to your own computer. It lists what the
machine needs, sets everything up step by step, checks that it works, and explains how to carry on with the next
phase, with or without Claude Code.

Nothing lives only in the cloud: everything built so far is merged into `main` on
[github.com/Barathparthi/workbench](https://github.com/Barathparthi/workbench). A fresh clone has all of it.

**Contents**

1. [Where the project stands](#1-where-the-project-stands)
2. [System requirements](#2-system-requirements)
3. [Step-by-step setup](#3-step-by-step-setup)
4. [Check that everything works](#4-check-that-everything-works)
5. [Continue building: the workflow](#5-continue-building-the-workflow)
6. [Differences from the cloud session](#6-differences-from-the-cloud-session)
7. [Command cheat sheet](#7-command-cheat-sheet)
8. [Troubleshooting](#8-troubleshooting)
9. [Open decisions that need the owner](#9-open-decisions-that-need-the-owner)

---

## 1. Where the project stands

Status on 2026-10-18 (the live record is [`docs/PROJECT_LOG.md`](PROJECT_LOG.md)):

| Phase                                | State                               | What exists in the repository                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00 — Environment, decisions & spikes | Gate CONDITIONAL (org answers open) | Pinned toolchain, `docs/ORG_DECISIONS.md`, spikes S1–S5 in `spikes/` with reports in `docs/spikes/`, ADR-005 (path routing), ADR-006 (remote terminal/files as a Theia frontend extension)                     |
| 01 — Monorepo foundation             | Done — gate PASS                    | npm workspaces, strict TypeScript, ESLint with package boundaries, Prettier, Vitest, library packages in `packages/*` (`@qe/domain` implemented), CI on Ubuntu + Windows, branch protection on `main`          |
| 02 — Theia product shell             | Merged — gate CONDITIONAL (D7)      | `apps/ide-browser` and `apps/ide-electron` (Theia 1.76.0), `extensions/qe-core`, built-in VS Code plugins pinned by SHA-256, workspace runtime image, Playwright smoke tests, ADR-012                          |
| 03 — Control plane and database      | Merged — gate PASS                  | `apps/control-plane` (Fastify 5 + PostgreSQL 18.6): workspace API, migrations, hash-chained audit log, OpenAPI file, dev Compose stack, Testcontainers integration tests, CI job `integration + coverage`      |
| **04 — Dev identity & RBAC**         | **Next**                            | Guide: `02_PHASES/PHASE_04_DEV_IDENTITY_AND_RBAC.md`; prompts: `03_PROMPTS/PHASE_04_PROMPTS.md`. Uses a local Keycloak in Docker Compose, so it needs **no** org decision (the corporate IdP, B1, is Phase 12) |
| 05 – 19                              | Not started                         | `02_PHASES/`                                                                                                                                                                                                   |

Merged pull requests so far: #1 (Phase 01), #2 (S1), #3 (S2 + S5), #4 (S4), #5 (S3), #6 (Phase 02), #7 (Phase 03).

---

## 2. System requirements

### 2.1 Hardware

| Resource | Minimum               | Recommended | Why                                                                                                                    |
| -------- | --------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| CPU      | 4 cores, x64 or arm64 | 8 cores     | Theia builds and the test suite are CPU-bound                                                                          |
| Memory   | 8 GB                  | 16 GB       | Theia bundling, Electron and a PostgreSQL container at the same time                                                   |
| Disk     | 20 GB free            | 40 GB free  | `node_modules` ≈ 0.9 GB, build output, Docker images (PostgreSQL ≈ 0.4 GB, runtime image ≈ 0.8 GB, Node base ≈ 1.7 GB) |
| Display  | Any desktop session   | —           | The Electron app and its smoke tests need one (on a headless Linux box, use `xvfb-run`)                                |

### 2.2 Operating system

| OS                                 | Status                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux — Ubuntu 22.04 / 24.04       | Best match: CI runs on `ubuntu-latest`; every command in this guide works as written                                                                                       |
| macOS 13 or later (Intel or Apple) | Works; use Docker Desktop, OrbStack or Colima for containers                                                                                                               |
| Windows 10 / 11                    | `npm run verify` is CI-tested on `windows-latest`. For Docker-based work, Docker Desktop with the WSL 2 backend; or work inside WSL 2 (Ubuntu) for a Linux-identical setup |

### 2.3 Software

| Tool                       | Version                                        | Needed for                                                                            | Notes                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git                        | 2.40 or later                                  | Everything                                                                            | LF line endings are enforced by `.gitattributes`                                                                                                                                  |
| **Node.js**                | **24.22.0 exactly** (`.nvmrc`)                 | Everything                                                                            | `engine-strict` is on: `npm ci` refuses Node outside `>=24.11.0 <25`. Use a version manager (nvm, nvm-windows or fnm)                                                             |
| npm                        | 11 or later                                    | Everything                                                                            | Ships with Node 24                                                                                                                                                                |
| Native build toolchain     | see Step 1                                     | `npm ci` (Theia's native modules: `native-keymap`, `keytar`, `node-pty`, `drivelist`) | Linux: `build-essential`, `python3`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`. macOS: Xcode Command Line Tools. Windows: Visual Studio 2022 Build Tools (C++) + Python 3 |
| **Docker** with Compose v2 | Docker Engine 24+ / Docker Desktop 4.30+       | PostgreSQL dev stack, integration tests, runtime image                                | Testcontainers needs access to the Docker socket                                                                                                                                  |
| Playwright Chromium        | installed by `npx playwright install chromium` | End-to-end smoke tests (`npm run test:e2e`)                                           | Version comes from the repo's `@playwright/test`                                                                                                                                  |
| `curl`                     | any                                            | Health checks in this guide                                                           | PowerShell users can use `Invoke-WebRequest`                                                                                                                                      |
| GitHub CLI `gh` (optional) | any recent                                     | Opening PRs, checking CI from the terminal                                            | Or use SSH keys and the GitHub website                                                                                                                                            |
| Claude Code (optional)     | latest                                         | Continuing the phases with the agent, as in the cloud session                         | Needs a Claude subscription or an Anthropic API account                                                                                                                           |
| Editor                     | any                                            | —                                                                                     | VS Code works well with the repo's ESLint/Prettier configuration                                                                                                                  |

### 2.4 Network access

The first install and some tasks download from the internet. Behind a corporate proxy, set `HTTPS_PROXY` (and
`npm config set proxy …` / `https-proxy …`) and configure Docker's proxy.

| Host                                                            | Used by                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `github.com`, `objects.githubusercontent.com`                   | Git, Electron binary download                                             |
| `registry.npmjs.org`                                            | `npm ci`                                                                  |
| Docker Hub (`registry-1.docker.io`)                             | PostgreSQL and Node base images (pinned by digest)                        |
| `open-vsx.org`                                                  | Built-in VS Code plugins — stand-in until the internal mirror (D7) exists |
| `cdn.playwright.dev` / `playwright.download.prss.microsoft.com` | Playwright's Chromium                                                     |

### 2.5 Ports used on 127.0.0.1

| Port | What                                                            |
| ---- | --------------------------------------------------------------- |
| 3000 | Browser IDE (`npm run start -w @qe/ide-browser`), runtime image |
| 3030 | IDE started by the Playwright smoke tests                       |
| 8080 | Control plane API                                               |
| 5432 | PostgreSQL from `deploy/compose/docker-compose.dev.yml`         |

If you already run PostgreSQL locally on 5432, stop it, or change the port mapping in the Compose file **and** the
two URLs in `apps/control-plane/.env`.

---

## 3. Step-by-step setup

### Step 1 — Install the operating-system prerequisites

**Ubuntu / Debian**

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential python3 \
  libx11-dev libxkbfile-dev libsecret-1-dev \
  xvfb            # only for running the Electron tests without a display
```

**macOS**

```bash
xcode-select --install          # compilers for native modules
# optional: Homebrew (https://brew.sh), then: brew install git gh
```

**Windows (native)**

1. Install **Git for Windows** (https://git-scm.com/download/win).
2. Install **Visual Studio 2022 Build Tools** (https://visualstudio.microsoft.com/visual-cpp-build-tools/) and tick
   the workload **"Desktop development with C++"**.
3. Install **Python 3** (https://www.python.org/downloads/ or `winget install Python.Python.3.12`).
4. Allow long paths (Theia's dependency tree is deep). In an administrator PowerShell:
   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
   ```

**Windows (WSL 2, the Linux-identical route)**: `wsl --install -d Ubuntu-24.04`, open the Ubuntu shell, keep the clone
**inside** the Linux file system (e.g. `~/src`, not `/mnt/c/...`) and follow the Ubuntu instructions.

### Step 2 — Install Node.js 24.22.0 with a version manager

**Linux / macOS (nvm)**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new terminal, then:
nvm install 24.22.0
nvm alias default 24.22.0
node --version     # v24.22.0
npm --version      # 11.x
```

**Windows (nvm-windows)**

```powershell
winget install CoreyButler.NVMforWindows
# open a new terminal, then:
nvm install 24.22.0
nvm use 24.22.0
node --version
```

(`fnm` works too: `fnm install 24.22.0 && fnm use 24.22.0`.) Inside the repository, `nvm use` / `fnm use` picks the
version from `.nvmrc`.

### Step 3 — Install Docker

- **Linux**: Docker Engine + Compose plugin (https://docs.docker.com/engine/install/), then let your user run it:
  `sudo usermod -aG docker $USER` and log out/in.
- **macOS / Windows**: Docker Desktop (https://www.docker.com/products/docker-desktop/). On Windows enable the
  **WSL 2 backend**. OrbStack or Colima also work on macOS (see Troubleshooting for Testcontainers settings).

Check:

```bash
docker version
docker compose version
docker run --rm hello-world
```

### Step 4 — Configure Git and GitHub access

```bash
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
# Windows only:
git config --global core.autocrlf false
git config --global core.longpaths true
```

Authenticate to GitHub with **one** of:

- GitHub CLI: `gh auth login` (choose HTTPS and "Login with a web browser"), or
- an SSH key: `ssh-keygen -t ed25519`, add `~/.ssh/id_ed25519.pub` at GitHub → Settings → SSH and GPG keys.

Never paste tokens or passwords into files in the repository or into a chat with an agent.

### Step 5 — Clone the repository

```bash
git clone https://github.com/Barathparthi/workbench.git     # or git@github.com:Barathparthi/workbench.git
cd workbench
nvm use        # or: fnm use   (reads .nvmrc)
```

### Step 6 — Install dependencies and build

The bootstrap script checks Node and Docker, runs `npm ci` and builds everything:

```bash
scripts/bootstrap.sh           # Linux / macOS
# Windows PowerShell:
# powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
```

Or step by step:

```bash
npm ci          # exact versions from package-lock.json
npm run build   # libraries, qe-core, control plane and both IDE apps
```

Install scripts only run for packages approved in `package.json` → `allowScripts`. Electron's binary is therefore
**not** downloaded by `npm ci`; fetch it once when you need the desktop app (Step 10).

### Step 7 — Run the full verification

```bash
npm run verify
```

This is what the required CI check runs: typecheck → lint → format check → unit tests → build. Expected ending
(numbers grow as the project grows):

```text
All matched files use Prettier code style!
 Test Files  31 passed (31)
      Tests  448 passed (448)
[build/browser] Finished with 0 errors …
```

### Step 8 — Start the database and the control plane

```bash
# 1. PostgreSQL 18.6 on 127.0.0.1:5432 (development credentials only)
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait

# 2. Local configuration (git-ignored; development values only)
cp apps/control-plane/.env.example apps/control-plane/.env
#   Windows: copy apps\control-plane\.env.example apps\control-plane\.env

# 3. Build, apply migrations, start the API on http://127.0.0.1:8080
npm run dev -w @qe/control-plane
```

In a second terminal:

```bash
curl http://127.0.0.1:8080/readyz
# {"status":"ready"}
curl -X POST http://127.0.0.1:8080/api/v1/workspaces \
  -H 'content-type: application/json' \
  -d '{"name":"demo","templateId":"tpl_python_pytest"}'
curl http://127.0.0.1:8080/api/v1/workspaces
```

Until Phase 04, `AUTH_MODE=dev` makes every request act as a seeded "dev" user. Stop the API with Ctrl+C (it shuts
down gracefully). Stop the database with `docker compose -f deploy/compose/docker-compose.dev.yml down`; add `-v` to
also delete its data.

Migrations alone: `npm run migrate -w @qe/control-plane` (uses `MIGRATION_DATABASE_URL` from `.env`).

### Step 9 — Run the integration tests

Testcontainers starts a throwaway PostgreSQL per test file; Docker must be running.

```bash
npm run test:integration          # 23 tests in apps/control-plane
npx vitest run --coverage         # unit + integration with coverage thresholds (the "integration + coverage" CI job)
```

### Step 10 — Run the IDE

```bash
# Built-in VS Code plugins (pinned and hash-checked; open-vsx.org is the stand-in until D7)
QE_VSX_URL=https://open-vsx.org npm run plugins:download
#   PowerShell: $env:QE_VSX_URL="https://open-vsx.org"; npm run plugins:download

# Browser IDE in local web mode: open http://127.0.0.1:3000
npm run start -w @qe/ide-browser

# Desktop (Electron) app: download the Electron binary once, then start
node node_modules/electron/install.js
npm run start -w @qe/ide-electron
```

Smoke tests (browser + Electron):

```bash
npx playwright install chromium          # Linux: npx playwright install --with-deps chromium
npm run test:e2e                         # headless Linux: xvfb-run -a npm run test:e2e
```

### Step 11 — (Optional) Build the workspace runtime image

```bash
QE_VSX_URL=https://open-vsx.org docker build -f images/workspace-runtime/Dockerfile \
  --build-arg QE_VSX_URL -t qews/runtime:dev .
docker run --rm -p 127.0.0.1:3000:3000 -e QE_MODE=local-web qews/runtime:dev
```

Publish it on 127.0.0.1 only: the IDE has no login of its own yet.

---

## 4. Check that everything works

| Check                               | Command                                                        | Expected                            |
| ----------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| Toolchain                           | `node --version && npm --version && docker compose version`    | `v24.22.0`, `11.x`, `v2.x`          |
| Everything CI's required check runs | `npm run verify`                                               | exit 0                              |
| Theia version guard                 | `npm run check:theia-versions`                                 | passes                              |
| Database + API                      | Step 8, then `curl http://127.0.0.1:8080/readyz`               | `{"status":"ready"}`                |
| Integration tests                   | `npm run test:integration`                                     | all passed                          |
| Browser IDE                         | `npm run start -w @qe/ide-browser`, open http://127.0.0.1:3000 | "QE Workspace" welcome page         |
| Smoke tests                         | `npm run test:e2e`                                             | all passed (git test needs plugins) |

---

## 5. Continue building: the workflow

### 5.1 How each phase is delivered

1. Read [`docs/PROJECT_LOG.md`](PROJECT_LOG.md) (status and next actions) and the phase guide in `02_PHASES/`.
2. Create a branch from an up-to-date `main`, one per phase or spike:
   ```bash
   git switch main && git pull
   git switch -c phase-04-identity-rbac
   ```
3. Work in small steps; commit each with a Conventional Commit message (`feat(control-plane): …`,
   `test(rbac): …`, `docs(phase-04): …`).
4. Before every push run `npm run verify` and, when the database is touched, `npm run test:integration`.
5. Update the records at the end of the phase: `docs/PROJECT_LOG.md`, `CHANGELOG.md`,
   `docs/phase-gates/PHASE_xx.md` (template `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`), `docs/ORG_DECISIONS.md` if a
   decision changed, README/MANIFEST if new folders appear.
6. Push and open a pull request to `main` using `.github/pull_request_template.md`:
   ```bash
   git push -u origin phase-04-identity-rbac
   gh pr create --fill        # or open it on github.com
   ```
7. CI must be green. The `main` ruleset requires `verify (ubuntu-latest)` and `verify (windows-latest)` on an
   up-to-date branch. **Recommended:** also add `integration + coverage` to the ruleset's required checks
   (GitHub → Settings → Rules → Rulesets → the `main` ruleset → Require status checks).
8. Review and merge; then start the next phase from the new `main`.

The non-negotiable rules in [`CLAUDE.md`](../CLAUDE.md) (and `AGENTS.md`) apply to every change.

### 5.2 Continuing with Claude Code locally

1. Install Claude Code (https://code.claude.com/docs):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash        # macOS / Linux / WSL
   # Windows PowerShell: irm https://claude.ai/install.ps1 | iex
   # or, with Node installed: npm install -g @anthropic-ai/claude-code
   ```
2. Start it in the repository root and log in when asked:
   ```bash
   cd workbench
   claude
   ```
   `CLAUDE.md` is loaded automatically, so the agent knows the repository rules, commands and conventions.
3. Start each session with the kit's bootstrap prompt (`03_PROMPTS/00_SESSION_BOOTSTRAP_PROMPT.md`), then the
   phase pack. For Phase 04, a good first message is:
   ```text
   Read docs/PROJECT_LOG.md and docs/LOCAL_DEVELOPMENT.md. We are continuing on a local machine.
   Start Phase 04 (Dev Identity & RBAC) using 03_PROMPTS/PHASE_04_PROMPTS.md:
   P04.0 context, then [LOOP-1] Inspect and [LOOP-2] Plan. Do not edit files until I approve the plan.
   Work on a new branch from main, one commit per step, and open a PR when the phase gate is written.
   ```
4. Follow the 8-step loop (`03_PROMPTS/01_STANDARD_8_STEP_LOOP.md`): Inspect → Plan (you approve) → Implement
   one step at a time → Review → Fix → Validate → Document → Gate.
5. Locally, Claude Code asks before running commands or editing files unless you allow them; approve with care,
   especially anything that pushes, deletes or touches Docker volumes.

### 5.3 Continuing without an agent

Use the same material by hand: the phase guide in `02_PHASES/` lists deliverables, steps and exit criteria; the
prompt pack in `03_PROMPTS/` doubles as a checklist; `01_ARCHITECTURE/` holds the contracts (API in
`05_API_CONTRACTS.md`, data model in `06_DATA_MODEL.md`, standards in `04_REPO_STRUCTURE_AND_STANDARDS.md`).

### 5.4 What Phase 04 needs on your machine

Nothing beyond this guide: Phase 04 adds a Keycloak container to `deploy/compose/` (dev IdP with test users alice,
bob, admin, audrey), so Docker and about 1 GB more disk are enough. The corporate identity provider (B1) is only
needed in Phase 12.

---

## 6. Differences from the cloud session

| Topic                    | Cloud session                                                                                                 | Local machine                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Open VSX, Debian mirrors | Blocked by the sandbox's egress policy; plugin hashes and the runtime image were verified on GitHub's runners | Normally reachable: `plugins:download` and the image build work locally |
| Docker daemon            | Started by hand inside the container                                                                          | Docker Desktop / Engine service                                         |
| Chromium for Playwright  | Pre-installed; tests used `CHROMIUM_PATH=/opt/pw-browsers/chromium`                                           | `npx playwright install chromium`; `CHROMIUM_PATH` not needed           |
| Branch                   | `claude/gallant-goldberg-v788zv` (fixed for the session)                                                      | Any branch name, one per phase (e.g. `phase-04-identity-rbac`)          |
| Pull requests            | Opened through the GitHub connector                                                                           | `gh pr create` or the GitHub website                                    |
| Electron                 | Ran under `xvfb-run`                                                                                          | Runs in your desktop session                                            |

---

## 7. Command cheat sheet

```bash
# Setup / maintenance
npm ci                                   # install exact dependencies
npm run build                            # build everything
npm run clean                            # remove build output
npm run verify                           # typecheck + lint + format + unit tests + build

# Focused checks
npm run typecheck
npm run lint                             # npx eslint --fix <path> to auto-fix
npm run format                           # write Prettier formatting
npx vitest run apps/control-plane        # unit tests of one folder
npx vitest run --project integration     # integration tests only
npm run check:theia-versions

# Control plane
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait
npm run dev -w @qe/control-plane
npm run migrate -w @qe/control-plane
npm run openapi:generate -w @qe/control-plane   # after changing routes or contracts; commit openapi.json
docker compose -f deploy/compose/docker-compose.dev.yml down     # add -v to wipe data

# IDE
QE_VSX_URL=https://open-vsx.org npm run plugins:download
npm run start -w @qe/ide-browser
node node_modules/electron/install.js && npm run start -w @qe/ide-electron
npm run test:e2e
```

---

## 8. Troubleshooting

| Symptom                                                               | Fix                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci` fails with `EBADENGINE` / "Unsupported engine"               | Wrong Node version. `nvm use` (or `fnm use`) in the repo root; `node --version` must print `v24.22.0`                                                                                            |
| `npm ci` fails compiling `native-keymap`, `keytar` or `node-pty`      | Missing native toolchain: Step 1 (Linux packages, Xcode CLT, or VS Build Tools + Python on Windows)                                                                                              |
| `npm ci` says the lockfile is out of sync                             | Use npm 11 (comes with Node 24); never edit `package-lock.json` by hand — change dependencies with `npm install <pkg>@<exact> -w <workspace>`                                                    |
| Windows: `ENAMETOOLONG` / path too long                               | Enable long paths (Step 1) and `git config --global core.longpaths true`; clone to a short path such as `C:\src\workbench`                                                                       |
| Electron app: "Electron failed to install correctly"                  | Run `node node_modules/electron/install.js` once                                                                                                                                                 |
| Electron on Linux exits with a display error                          | Run from a desktop session, or `xvfb-run -a …`                                                                                                                                                   |
| Testcontainers: "Could not find a working container runtime strategy" | Start Docker. Colima: `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Podman: also `TESTCONTAINERS_RYUK_DISABLED=true` |
| `docker compose up` fails: port 5432 already in use                   | Stop the local PostgreSQL service, or change the port in the Compose file and in both URLs in `apps/control-plane/.env`                                                                          |
| `/readyz` answers 503                                                 | Migrations not applied or database down: `npm run migrate -w @qe/control-plane`; check `docker compose … ps`                                                                                     |
| Control plane exits with code 78                                      | Configuration error; the message names the variable. Compare `.env` with `.env.example`                                                                                                          |
| Changed the database init script but nothing changed                  | `postgres-init/` runs only on an empty volume: `docker compose … down -v`, then `up` again (this deletes local data)                                                                             |
| `openapi.test.ts` fails                                               | Routes or contracts changed: `npm run openapi:generate -w @qe/control-plane` and commit `apps/control-plane/openapi.json`                                                                        |
| `plugins:download` fails with a hash mismatch                         | The registry served a different file than the pinned one. Do not re-pin blindly: check the source, then follow `scripts/plugins.ts lock` (ADR-012)                                               |
| Smoke test "git lists the changed file" is skipped                    | Built-in plugins are missing: run `plugins:download` first                                                                                                                                       |
| Format check fails                                                    | `npm run format`, then commit                                                                                                                                                                    |

---

## 9. Open decisions that need the owner

From [`docs/ORG_DECISIONS.md`](ORG_DECISIONS.md) and the gate records; none of them blocks Phase 04.

| Item                                                | Needed by       | Notes                                                                |
| --------------------------------------------------- | --------------- | -------------------------------------------------------------------- |
| D7 — internal Open VSX mirror URL                   | Phase 05        | Then set `QE_VSX_URL` in CI and re-pin plugin hashes from the mirror |
| D9 — hosted DNS name and wildcard certificate       | Phase 05 / 16   | For `qe-workspace.<corp-domain>` and webview origins (ADR-005)       |
| D12, D13 (docs URL), D14 (Theia AI / MCP)           | see the sheet   | Listed with defaults in `ORG_DECISIONS.md`                           |
| B1 — corporate identity provider                    | Phase 12        | Phase 04 uses a local Keycloak                                       |
| `ssh2` certificate patch (spike S4)                 | Phase 08        | Recommendation: `patch-package` plus an upstream PR                  |
| Phase 00 architecture review (tech lead + security) | before Phase 05 | Gate condition of Phase 00                                           |
| Second maintainer                                   | when one joins  | Then require a pull request + 1 approval on `main`                   |
