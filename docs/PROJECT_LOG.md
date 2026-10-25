# Project Log — QE Workspace

A dated record of what has been done in this repository, why, and what is still open. It starts from the
repository's initial state (the first commit). Newest entries go at the **bottom** of the log section; the
status snapshot at the top is kept current.

How to add an entry: date, phase, what changed (with commit or PR), decisions and deviations from the kit,
evidence, and open items. Release-level changes also go in `/CHANGELOG.md`.

---

## Status snapshot (updated 2026-10-18)

| Phase                                | State                                                                                                                        | Record                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 00 — Environment, decisions & spikes | **Gate proposed CONDITIONAL** — S1–S5 done, ADR-005/006 accepted; org answers + review open                                  | [`phase-gates/PHASE_00.md`](phase-gates/PHASE_00.md) |
| 01 — Monorepo foundation             | **Done — gate PASS** (CI green, branch protection on)                                                                        | [`phase-gates/PHASE_01.md`](phase-gates/PHASE_01.md) |
| 02 — Theia product shell             | **Merged — gate CONDITIONAL** (internal Open VSX mirror, D7)                                                                 | [`phase-gates/PHASE_02.md`](phase-gates/PHASE_02.md) |
| 03 — Control plane and database      | **Done — gate PASS** ([PR #7](https://github.com/Barathparthi/workbench/pull/7) merged, CI green)                            | [`phase-gates/PHASE_03.md`](phase-gates/PHASE_03.md) |
| 04 — Dev identity & RBAC             | **Done — gate PASS** ([PR #9](https://github.com/Barathparthi/workbench/pull/9); Keycloak + session integration green in CI) | [`phase-gates/PHASE_04.md`](phase-gates/PHASE_04.md) |
| 05 — Workspace runtime & routing     | **Done** ([PR #10](https://github.com/Barathparthi/workbench/pull/10), CI green) — M1 end-to-end run with Docker still open  | [`phase-gates/PHASE_05.md`](phase-gates/PHASE_05.md) |
| 06 — Terminal hardening              | **Done** (merged to `main`, `1771c61`; CI smoke green after resize-test fix)                                                 | [`phase-gates/PHASE_06.md`](phase-gates/PHASE_06.md) |
| 07 — Target registry & policy        | **Built — gate CONDITIONAL** (pushed; CI integration and merge pending)                                                      | [`phase-gates/PHASE_07.md`](phase-gates/PHASE_07.md) |
| 08 — SSH broker & remote terminal    | **Built locally — gate CONDITIONAL** (CI OpenSSH/PostgreSQL suites, M2 run with Docker)                                      | [`phase-gates/PHASE_08.md`](phase-gates/PHASE_08.md) |
| 09 – 19                              | Not started                                                                                                                  | `02_PHASES/`                                         |

Milestones: M1 (end of Phase 06) — not reached.

**Next actions**

1. Phase 00 gate conditions: send sections A8 and B–E of [`ORG_DECISIONS.md`](ORG_DECISIONS.md) (incl. D9,
   D12) to the owning teams, A8 with a licence review; hold the architecture review (tech lead + security)
   before Phase 05.
2. Decide how to carry the `ssh2` certificate patch (S4): `patch-package` + upstream PR is the recommendation.
3. Phase 02 follow-ups: ratify ADR-012; name the Open VSX mirror (D7) and re-pin plugin hashes from it; decide
   D13 (docs URL) and D14 (Theia AI/MCP).
4. Phase 04: push `phase-04-identity-rbac`, open the PR, confirm `integration + coverage` is green, then mark PASS.
   Next is Phase 05 (workspace runtime and routing).
5. Add `integration + coverage` to the required status checks of the `main` ruleset.
6. When a second maintainer joins: add "require a pull request + 1 approval" to the `main` ruleset.

---

## Log

### 2026-10-17 — Initial state (commit `1895cc9`, "first commit")

The repository was created by Barath Kumar P containing only the **QE Workspace Production Implementation
Kit (v2)** — documentation, no code, no tooling, no `.gitignore`.

| Folder                     | Files | What it is                                                                                                                                                          |
| -------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`, `MANIFEST.md` |     2 | Kit overview (modes, phase table, milestones, rules) and file index                                                                                                 |
| `00_START_HERE/`           |     4 | Executive summary, how to use the kit, org-decision questionnaire, glossary                                                                                         |
| `01_ARCHITECTURE/`         |    12 | PRD, solution architecture, stack, repo standards, API/WS contracts, data model, threat model, remote connectivity, local/web parity, observability, testing, CI/CD |
| `02_PHASES/`               |    20 | Step-by-step guides for phases 00–19                                                                                                                                |
| `03_PROMPTS/`              |    23 | Agent session bootstrap, 8-step loop, one prompt pack per phase, utilities                                                                                          |
| `04_OPERATIONS/`           |     6 | Runbooks, readiness checklist, acceptance criteria, demo, user/admin guides                                                                                         |
| `05_ADR/`                  |     2 | ADR-001 … ADR-010 (ADR-005 routing and ADR-006 remote terminal/FS still _Proposed_)                                                                                 |
| `06_TEMPLATES/`            |     6 | CLAUDE.md/AGENTS.md, PR template, phase gate, ADR template, CODEOWNERS/config snippets                                                                              |
| `07_PLANNING/`             |     3 | Roadmap, team/RACI, risk register R1–R13                                                                                                                            |
| `reference/`               |     1 | Original technical architecture (`.docx`)                                                                                                                           |

**What the product is.** QE Workspace is a VS Code-like IDE (Eclipse Theia) usable as **Hosted Web**
(Kubernetes runtimes), **Local Web** (Docker on localhost) and **Desktop** (Electron), with the same
extensions and workspace model in every mode. It adds an integrated terminal, **brokered SSH** to
registered lab systems (remote terminal + remote file editing), a QE test runner, and enterprise controls
(OIDC SSO, RBAC, secret manager with short-lived SSH certificates, audit, OpenTelemetry, hardened Kubernetes).

**The plan.** 20 phases (00–19) and five demo milestones (M1 end of P06 … M5 end of P18), estimated at
20–26 weeks for a 5–7 person team. Three rules never bend: the browser is a client, not a trusted computer;
no connection to arbitrary hosts; one workspace contract for all clients.

**Org decisions** (IdP, Kubernetes platform, secret manager, lab inventory, …) were all unanswered.

### 2026-10-17 — Repository hygiene: `.gitignore` (commit `6e9c7be`)

Added a root `.gitignore` covering dependencies, TypeScript/Theia/Electron build output, coverage and tool
caches, Helm packages, local environment files and private keys (`.env*` except `.env.example`, `*.pem`,
`*.key`, `id_*`), editor and OS files. Theia output paths are scoped to `apps/*` and `extensions/*` so they
cannot hide source folders elsewhere.

### 2026-10-17 — Phase 00 (partial): toolchain pinned, decisions sheet created

Done:

- **Toolchain pinned and verified** against the npm registry and Theia's repository on 2026-10-17
  (details and sources in [`ORG_DECISIONS.md` §F](ORG_DECISIONS.md#f-toolchain-pinned-2026-10-17)):
  Node.js **24.22.0** (Active LTS "Krypton"; Theia 1.76.0 requires `node >=24`), npm 11.19.1,
  TypeScript **5.9.3** (Theia's own version), Electron 42.8.1 (peer of `@theia/electron` 1.76.0).
- Theia itself: **1.76.0** (latest, 2026-09-24) recorded as the candidate; 1.74.x (npm dist-tag `patch`,
  still receiving fixes) is the alternative if the org prefers the maintained line. Final pick happens with
  spike S1 / Phase 02 — the Node and TypeScript pins hold for both.
- [`ORG_DECISIONS.md`](ORG_DECISIONS.md) created from `00_START_HERE/03_DECISIONS_BEFORE_CODING.md`. Every
  row shows the kit default marked **assumed**; only facts visible from the repository are marked confirmed
  (Git host = GitHub).

Not done (needs people, infrastructure or the Theia build): org answers for sections A–E, spikes S1–S5,
ADR-005/ADR-006 decisions, architecture review. See [`phase-gates/PHASE_00.md`](phase-gates/PHASE_00.md).

**Deviation:** Phase 01 lists "Phase 00 gate PASS" as a prerequisite. Phase 01 was built anyway because it
depends only on the pinned Node/TypeScript versions, not on spike outcomes. Recorded as risk R15.

### 2026-10-17 — Phase 01: monorepo foundation (commits `cf57845`, `ff71118`)

Built the skeleton every later phase builds on, following `02_PHASES/PHASE_01_MONOREPO_FOUNDATION.md` and
prompts P01.1–P01.6:

- **Root tooling** — npm workspaces (`packages/*`, `extensions/*`, `apps/*`, `tests/*`), `.nvmrc`,
  `.npmrc` (`engine-strict`, `save-exact`), `.editorconfig`, `.gitattributes` (LF), strict
  `tsconfig.base.json`, `tsconfig.build.json` (project references), Prettier, `npm run verify`.
- **Ten library packages** — `domain`, `contracts`, `rbac`, `policy`, `broker-core`, `secrets`,
  `runtime-providers`, `telemetry`, `client-sdk`, `test-utils`; dependencies and references wired exactly as
  the dependency rules in `01_ARCHITECTURE/04` §1.
- **`@qe/domain`** — the 23 `ErrorCodes` with their HTTP statuses (05_API_CONTRACTS §3), `DomainError`
  (`code`, `httpStatus`, `details`, `cause`), `assertNever`, workspace and remote-session state machines
  (02_SOLUTION_ARCHITECTURE §6) with tests for every legal **and** illegal transition.
- **ESLint** — typescript-eslint `strictTypeChecked`, `no-explicit-any`, `no-floating-promises`,
  `child_process` only in runtime-providers/broker-core/qe-runner backend, no `eval`, and
  eslint-plugin-boundaries encoding the package graph (incl. the ADR-008 exception for the qe-remote
  Electron backend).
- **Vitest** — projects `unit` and `integration`; coverage gates 90 % (domain, rbac, policy, broker-core)
  and 75 % elsewhere.
- **Proof tests** (`tests/lint/`) — 33 cases showing forbidden imports fail lint and allowed ones pass;
  a guard keeping imports, `package.json` dependencies and `tsconfig` references in sync.
- **Repo hygiene** — `CLAUDE.md`, `AGENTS.md`, PR template, CODEOWNERS, CI workflow (ubuntu + windows,
  actions pinned by SHA, read-only token), `scripts/bootstrap.sh` / `.ps1`.

Decisions and deviations from the kit (rationale in [ADR-011](../05_ADR/ADRS.md)):

| Topic                 | Kit says                                            | Done instead                                       | Why                                                           |
| --------------------- | --------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| Kit docs              | Copy `01_ARCHITECTURE/` → `docs/architecture/` etc. | Kept in place; `CLAUDE.md` maps the paths          | The kit lives in this repo; copies would drift                |
| Package resolution    | `main`/`types` → `dist`                             | `exports` with an `@qe/source` condition first     | Tests and lint work before a build and never see stale `dist` |
| State-machine helpers | `canTransition` in each file                        | `canTransitionWorkspace` / `canTransitionSession`  | Both are exported from one index                              |
| `DomainError`         | `(code, message?, details?)`                        | `(code, message?, { details, httpStatus, cause })` | 04 §2 requires `httpStatus`; `cause` keeps error chains       |
| `clean` script        | `git clean -xdf -e .env`                            | `scripts/clean.mjs` (build output only)            | `git clean -x` also deletes untracked source files            |
| CODEOWNERS            | Team handles                                        | `@barathparthi` on every path                      | The teams do not exist yet                                    |
| `test:integration`    | —                                                   | `--passWithNoTests`                                | No integration tests until Phase 03                           |
| Lint fixtures         | Fixture files in `tests/lint-fixtures`              | In-memory snippets linted with the real config     | Real fixture files would fail `npm run lint`                  |

Evidence: [`phase-gates/PHASE_01.md`](phase-gates/PHASE_01.md) (clean-install run, 277 tests, 100 %
coverage, planted violations rejected).

Open: CI has not yet run on GitHub (Windows result unknown); branch protection not enabled; one high
severity advisory in dev tooling (`braces` via eslint-plugin-boundaries, no upstream fix — risk R14).

### 2026-10-17 — Phase 01 merged ([PR #1](https://github.com/Barathparthi/workbench/pull/1))

@Barathparthi opened and merged PR #1 (merge commit `b35c692`). The `ci` workflow passed on the PR
(`verify (ubuntu-latest)` and `verify (windows-latest)`) and again on `main` — the Windows half of the
Phase 01 exit criterion is now met. The PR was merged 16 s after opening, before CI finished, so branch
protection is evidently not enforcing required checks yet; that is the remaining gate condition.

### 2026-10-17 — Phase 00 spike S1: Theia hello app (browser + Electron)

Built [`spikes/s1-theia-hello/`](../spikes/s1-theia-hello/): one extension `qe-hello` (command
`qe.hello`) used unchanged by a browser app and an Electron app on Theia 1.76.0, plus Playwright checks
that run the command from the palette and spawn a shell in the integrated terminal. Both targets pass;
screenshots and measurements are in the [S1 report](spikes/S1_THEIA_HELLO.md).

Decisions:

- **Theia pinned to 1.76.0** (Electron 42.8.1); 1.74.2 is not needed.
- New org decision **D12**: build-time access to `artifacts.electronjs.org` (Electron headers) or a mirror.
- Linux build packages (`libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`) added to the toolchain table.

Findings that change the kit's Phase 02 assumptions: Theia 1.76 bundles with **esbuild** (not webpack —
`.gitignore`/ESLint updated for `gen-esbuild.*.mjs`); npm 11.19 needs `allowScripts` approvals for native
modules; Workspace Trust prompts on first open; all native modules are Node-API, so they load in Electron
even when the Electron rebuild cannot download headers (this sandbox blocks electronjs.org).

Repository changes: spikes excluded from Prettier (already outside workspaces, lint and tests);
risk R15 closed, R9 updated, R16 added.

### 2026-10-17 — Phase 02 prerequisites: PR #2 merged, Phase 01 gate PASS

@Barathparthi merged [PR #2](https://github.com/Barathparthi/workbench/pull/2) (spike S1, CI green on both
operating systems) and added a ruleset on `main`: required `verify (ubuntu-latest)` and
`verify (windows-latest)` checks on an up-to-date branch, no force-push, no deletion — verified through the
GitHub API. Pull requests and reviews are not required yet (single maintainer). **Phase 01 gate: PASS.**

### 2026-10-17 — Phase 00 spike S2: Theia behind a reverse proxy → ADR-005

Built [`spikes/s2-proxy/`](../spikes/s2-proxy/): a Fastify proxy in front of the S1 browser app, in path
(`/w/{id}/`) and subdomain (`{id}.ws.localhost`) modes, plus Playwright checks that record every request and
WebSocket. Both modes work with Theia unchanged. With two workspaces open in one browser, path routing breaks
the first workspace on reconnect (`403`): Theia's `theia-connection-token` cookie is `Path=/` and the
backends overwrite each other's token. Rewriting `Set-Cookie` to `Path=/w/{id}/` at the gateway fixes it
(reproduced and fixed, 2/2 runs each). Details: [S2 report](spikes/S2_REVERSE_PROXY.md).

Decisions: **ADR-005 accepted — path-based routing** (matches `ideUrl: "/w/{id}/"`), with the gateway
requirements listed in the ADR; org decision D9 now includes the `*.webview.<host>` wildcard
certificate; risk R1 mitigated.

Process note: the S2 check scripts initially reported a false failure because a backgrounded tab is throttled
by Chromium; the final checks bring each tab to the front, and the "no fix" failure was re-confirmed with the
corrected script (it is the `403`, not throttling).

### 2026-10-17 — Phase 00 spike S5: Open VSX availability

Built [`spikes/s5-openvsx/`](../spikes/s5-openvsx/), a dependency-free check of 24 extensions (required by A8,
alternatives, Theia built-ins, two expected-missing). The sandbox cannot reach open-vsx.org, so a path-filtered
workflow (`spike-s5-openvsx`) ran it on GitHub's runners in PR #3; the script was first tested against a local
stub registry. **All required extensions are available from verified publishers and compatible with Theia 1.76
(API 1.139.0).** Pylance and Remote-SSH are missing as expected: basedpyright replaces Pylance; our broker
replaces Remote-SSH. Microsoft-published extensions lag their VS Code releases by months, and five need a
licence review. Details and a proposed allowlist: [S5 report](spikes/S5_OPEN_VSX.md). A8 updated (still to be
confirmed by the QE rep and legal); risk R4 mitigated.

### 2026-10-17 — PR #3 merged; Phase 00 spike S4: `ssh2` deep-check

@Barathparthi merged [PR #3](https://github.com/Barathparthi/workbench/pull/3) (S2, S5, Phase 01 gate PASS).

Built [`spikes/s4-ssh2/`](../spikes/s4-ssh2/): a local OpenSSH 9.6 target and bastion plus a Vault 2.2 dev server
as SSH user CA (Docker is not available in the sandbox, so `env.sh` runs real `sshd` processes), and 20 checks
with `ssh2` 1.17.0. Results ([S4 report](spikes/S4_SSH2.md)):

- Pinned `SHA256:` host-key verification matches `ssh-keygen`, works asynchronously, and on mismatch fails during
  key exchange **before any credential is sent**. Without a verifier `ssh2` accepts any host key, so
  `SshTransport` must make it mandatory.
- **Vault certificates need a 5-line `ssh2` patch** (risk R3 materialised): `ssh2` writes the certificate
  algorithm name into the signature blob. With the patch: 20/20 checks, twice; wrong-principal and expired
  certificates stay rejected. Agent-held certificates are not used by `ssh2`.
- Jump host with separately pinned hops; bastion `PermitOpen` and target `AllowTcpForwarding no` enforced.
- PTY resize works; **Ctrl+C must be `\x03` through the PTY** (26 ms) — the SSH `signal` request did not
  interrupt a foreground job.
- `ssh2` error levels map cleanly to our `ErrorCode`s (table in the report).

Decisions: ADR-002 and ADR-007 addenda (binding rules for `SshTransport`; carry the patch + upstream PR, keep
the ephemeral key in memory, set Vault `key_id_format` to include the user). Org decisions C3/C4 annotated;
risk R3 mitigated with the patch. Not tested here: Windows/macOS agents (Phase 10).

### 2026-10-17 — PR #4 merged; Phase 00 spike S3: remote terminal + remote files → ADR-006

@Barathparthi merged [PR #4](https://github.com/Barathparthi/workbench/pull/4) (S4).

Built [`spikes/s3-remote/`](../spikes/s3-remote/): the same feature — a remote terminal and a remote file you
can edit, through a stub of the contract's session API (tickets, `qews.v1` WebSocket, `fs/{op}`) over `ssh2` to
the S4 OpenSSH target — written twice and loaded side by side into one browser and one Electron app on Theia
1.76: **option A** as a VS Code web extension (`Pseudoterminal` + `FileSystemProvider`, frontend plugin worker),
**option B** as a Theia frontend extension (terminal widget with `isPseudoTerminal` + `FileSystemProvider` via a
`FileServiceContribution`). Playwright checks read the evidence back from the remote host. Results
([S3 report](spikes/S3_REMOTE_TERMINAL_FS.md)):

- Browser: both options pass — remote terminal at the widget's real size, Ctrl+C → exit 130, remote file
  open/edit/save in 0.4 s, A's webview in its own origin. The broker saw every session with the IDE's `Origin`,
  so both keep SSH traffic out of the runtime (P9).
- Electron: B passes the same checks; **A never runs** — Theia 1.76 does not start the frontend plugin host in
  Electron, and no packaging of A works on the desktop without running it in the hosted runtime's plugin host.
- The Electron renderer is loaded from `file://` (WebSocket `Origin: file://`), so the desktop must relay
  broker traffic through its backend with a Bearer token, not call the hosted broker from the renderer.
- Smaller findings: a DI cycle if the `FileServiceContribution` injects terminal services; a PTY size race;
  keystrokes before the shell opens must be queued; Theia's save-conflict check works through the provider but
  SFTP `mtime` has whole-second resolution; Ctrl+C travels as `\x03` input (matches S4).

Decisions: **ADR-006 accepted — option B**, with the transport behind `ConnectionClient` per mode (desktop
relays through the Electron backend). Risk R2 likelihood lowered, R1 updated (webview origin confirmed), **R17**
added (desktop renderer origin). Phase 00 gate updated: all spikes done, **proposed CONDITIONAL** on the org
answers and the architecture review.

Process note: the first combined A+B run failed B's save behind an overwrite dialog. Cause: the check reset
`hello.txt` while an editor restored from the previous group was still open — clearing `localStorage` before a
reload does not help because Theia stores the layout again on unload. The checks now run "Reset Workbench
Layout" before each group.

### 2026-10-17 — PR #5 merged; Phase 02: Theia product shell

@Barathparthi merged [PR #5](https://github.com/Barathparthi/workbench/pull/5) (S3, ADR-006, Phase 00 gate
CONDITIONAL) and approved the Phase 02 plan with three choices: pinned and hashed plugins instead of
`theia download:plugins`, no in-IDE marketplace, no native rebuild for Electron.

Built, one commit per step (details in [`phase-gates/PHASE_02.md`](phase-gates/PHASE_02.md)):

- **Tooling**: `tsconfig.theia.json` (CommonJS + decorators, keeps `@qe/source`), Theia output ignored by lint
  and format, Linux build packages in CI, install scripts of Theia's native modules approved explicitly.
- **`extensions/qe-core`**: QE commands (About works, three placeholders), `QeEnvironment` parsed once at backend
  startup from `QE_MODE` / `QE_CONTROL_PLANE_URL` / `QE_WORKSPACE_ID` with Zod and served over Theia RPC (never
  from the URL; Electron is always desktop; bad configuration exits 78), `qe.*` preferences (telemetry only in
  Electron), mode status bar item, QE welcome page, About dialog, favicon, placeholder logo.
- **Apps**: `@qe/ide-browser` and `@qe/ide-electron` with the same 20 Theia extensions; the version guard fails
  on drift, ranges, a missing extension in one app or `@theia/vsx-registry`.
- **Plugins**: nine built-in `vscode.*` plugins pinned by SHA-256, verified and unpacked by `scripts/plugins.ts`.
  CI caught that Theia 1.76 deploys only unpacked system plugins, hence the small ZIP extractor.
- **Runtime image**: multi-stage, digest-pinned, UID 1000, tini; built and checked in the `ide` workflow.
- **Smoke tests**: browser (branding, QE commands, settings, explorer, editor save, terminal, search, git,
  same-origin traffic) and Electron (branding, desktop mode, QE commands, desktop-only setting).

Decisions and deviations: ADR-012; Electron 42.8.1 → 42.11.10 (four high-severity advisories); the
`QeEnvironment` comes over RPC instead of a new `/qe/env` HTTP route; electron-builder configuration only
(installers are Phase 10); runtime image defaults to `QE_MODE=hosted` (self-review finding). New org decisions
D13 (docs URL) and D14 (Theia AI/MCP pulled in by `@theia/plugin-ext`); D7 and D12 updated; risks R16 mitigated,
R14 updated, R18 and R19 added.

Environment notes: this container cannot reach Open VSX or the Debian mirrors (egress policy), so the plugin hashes
and the runtime image come from GitHub's runners; the built app was checked locally as UID 1000 from a
read-only mount.

### 2026-10-18 — PR #6 merged; Phase 03: control plane and database

@Barathparthi merged [PR #6](https://github.com/Barathparthi/workbench/pull/6) (Phase 02). For the database the
owner first offered a Supabase URL, then decided: **one self-hosted PostgreSQL, no Supabase** (D4 confirmed).
Development uses Docker Compose, tests use Testcontainers, both on PostgreSQL 18.6 pinned by digest; the migrator
and application roles stay separate.

Built (details in [`phase-gates/PHASE_03.md`](phase-gates/PHASE_03.md)):

- **`@qe/contracts`**: Zod v1 DTOs for workspaces and templates, `ProblemDetails`, and an allowlist of audit
  metadata per action.
- **`apps/control-plane`** (Fastify 5 + Zod type provider): fail-fast config (exit 78), problem+json errors,
  request IDs, pino with redaction, helmet, per-route rate limits, Origin allowlist on unsafe methods, health
  endpoints, graceful SIGTERM shutdown, OpenAPI generated from the routes (`openapi.json`, drift test).
  Every route must declare `permission`, `audit` and `rateLimit` or the server refuses to register it.
- **Database**: `0001_init.sql` (06 §2 schema, `qews_app` role with DML only, append-only audit triggers),
  `0002` template seed, a checksummed migration runner under an advisory lock; Kysely repositories with
  membership-scoped reads and compare-and-set state transitions; hash-chained audit writer that fails closed
  inside the caller's transaction.
- **Workspace API**: list, create, get, update, delete and templates. Non-members get 404, editors may update but
  not delete, only stopped/created/failed workspaces can be deleted. Create and delete write audit events.
- **Dev stack and CI**: `deploy/compose/docker-compose.dev.yml`, `.env.example`; `npm run dev -w @qe/control-plane`
  migrates and starts; new CI job `integration + coverage` (unit + Testcontainers, coverage thresholds).

Decisions and deviations: D4 confirmed; partial unique index on workspace names; `audit_events.seq` and
append-only triggers; no 501 lifecycle stubs; no `WORKSPACE_UPDATE` audit action; a seeded dev principal until
Phase 04 (refused in production). The `verify` job now runs unit tests without coverage; the coverage gate moved
to the integration job, which sees the database code.

Self-review findings fixed before the PR: unhandled pool `error` event (process crash on a database restart),
unused `ALLOWED_ORIGINS`, routes without a permission skipping authentication.

### 2026-10-18 — PR #7 merged (Phase 03 PASS); local development guide

@Barathparthi merged [PR #7](https://github.com/Barathparthi/workbench/pull/7) with all five checks green on GitHub
(`verify` on ubuntu and windows, `integration + coverage`, `runtime image`, `smoke (browser + Electron)`); the
Phase 03 gate is PASS.

Correction: the Phase 03 PR and the previous next-actions list said Phase 04 needs "D2 (identity provider)". D2 is
the ingress controller, and Phase 04 needs no org decision: it runs against a local Keycloak in Docker Compose. The
corporate identity provider is B1, needed in Phase 12.

At the owner's request, the work continues on a local machine instead of the cloud session. Added
[`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md): project status, hardware/OS/software/network requirements, step-by-step
setup for Linux, macOS and Windows (Node 24.22.0, native toolchain, Docker, Git), verification, running the database,
control plane and IDE, the per-phase PR workflow, continuing with Claude Code locally, differences from the cloud
session, a command cheat sheet, troubleshooting and the open owner decisions. `CLAUDE.md`, `AGENTS.md`, README and
MANIFEST point to it.

### 2026-10-18 — Phase 04: development identity and RBAC (branch `phase-04-identity-rbac`)

Built on the owner's local Windows machine (Node 24.22.0, no Docker — owner chose unit tests locally and
Docker-based tests in CI; dependencies installed with `--ignore-scripts` because Visual Studio Build Tools are not
installed). Details: [`phase-gates/PHASE_04.md`](phase-gates/PHASE_04.md).

- **`@qe/rbac`**: 22 permissions, role matrix (`qe.user`, `qe.lead`, `qe.admin`, `auditor`, `lab.<name>.user`),
  `permissionsFor`, `ROLE_MAPPINGS` parser (unknown roles refused), workspace-role ranking.
- **Control plane**: OIDC login/callback/logout with `openid-client` 6.8.8 (PKCE S256, state, nonce) behind an
  `OidcProvider` interface; server-side sessions (`0003_web_sessions.sql`, hash-only tokens, idle/absolute expiry,
  disabled users); session-bound CSRF tokens; authorization in `onRequest` for every route; `/api/v1/me`; five new
  audit actions; config for OIDC/sessions with production rules (https, secure cookies).
- **Dev stack**: Keycloak 26.8.1 (by digest) with realm `qe` and four dev users in compose; `.env.example` updated.
- **Tests**: authz matrix (every route × persona), hook/route/config/OIDC unit tests, session lifecycle against
  PostgreSQL, full login against Keycloak (integration, CI only here). 639 unit tests pass locally.
- **`@qe/client-sdk`**: `ControlPlaneClient` (credentials, CSRF echo, 401 → login URL, problem+json errors).

Deviations: authorization in `onRequest` (not `preHandler`); Bearer tokens deferred to Phase 10; status-bar user
display deferred to Phase 05; authz matrix kept in the control-plane test folder. A Phase 03 rule was kept on
purpose: unknown paths need a session (no anonymous route enumeration).

### 2026-10-18 — PR #9 merged (Phase 04)

The owner pushed `phase-04-identity-rbac` and merged it as [PR #9](https://github.com/Barathparthi/workbench/pull/9)
(merge commit `9ec1f39`). The repository is private and this machine has no GitHub login, so CI results are checked by
the owner on GitHub; local `main` is synced with `git fetch` + `git merge --ff-only`.

### 2026-10-19 — Phase 05: workspace runtime and routing (branch `phase-05-workspace-runtime`)

Built locally (Windows, Node 24.22.0, no Docker). Details: [`phase-gates/PHASE_05.md`](phase-gates/PHASE_05.md).

- **`@qe/runtime-providers`**: Docker and Kubernetes providers over typed Engine/Kubernetes API clients; hardened
  container and restricted pod specs; first-start git clone with positional arguments.
- **Control plane**: lifecycle (start/stop/SSE, compare-and-set, readiness probe, timeout, quota, audit), reconciler
  (lost/stuck/orphan/delete/idle), delete removes runtime and volume, workspace router for HTTP and WebSocket with
  per-request session/membership/state checks, credential stripping and cookie path scoping; runtime config.
- **IDE**: signed-in user and Sign Out in the status bar (hosted mode).
- **Runtime image**: setuid/setgid bits removed.
- Tests: 771 unit tests pass locally (router against a real local upstream, authz matrix 153 cases); lifecycle and
  reconciler integration tests run in CI.

Fix made during the phase: authorization's CSRF exemption for the router (`csrf: 'origin'`) and closing proxied
sockets on shutdown (found by the router tests).

### 2026-10-19 — CI on the Phase 05 branch: 813/821; two fixes

The owner shared the `integration + coverage` log. Phase 04's integration suites (real Keycloak login, session
lifecycle on PostgreSQL) passed → **Phase 04 gate PASS**. Eight Phase 05 failures had two causes: a product bug in
workspace delete (the `→ DELETING` transition was lost in an edit) and shared-user quota exhaustion in the lifecycle
tests. Both fixed on `phase-05-workspace-runtime`; details in the Phase 05 gate record.

### 2026-10-19 — PR #10 merged (Phase 05, CI green); Phase 06 terminal hardening

The owner reported CI green and merged `phase-05-workspace-runtime` as PR #10 (`56a7dfb`). Phase 06 built on
`phase-06-terminal`: a QE terminal policy decorating Theia's shell terminal server (shell allowlist in hosted/local
web, terminal limit, `TERM`/`LANG` defaults), scrollback default 10,000, UTF-8 locale in the runtime image, and a
browser E2E suite for PTY, resize, Ctrl+C, output flood and UTF-8 (runs in CI). Details:
[`phase-gates/PHASE_06.md`](phase-gates/PHASE_06.md).

### 2026-10-19 — Phase 06 merged; Phase 07 targets and connection policy (branch `phase-07-targets-policy`)

Phase 06 was merged to `main` (`1771c61`). While Phase 07 was in progress its uncommitted files were stashed
("phrase 7") and the checkout moved; they were restored from the stash on `phase-07-targets-policy` with nothing lost.

Built: `@qe/policy` (SSRF address guard with pinned address, pure connection decision), target/policy/host-key/
credential-reference contracts, control-plane admin APIs (audited), role-filtered target list, session opening with
single-use Origin-bound tickets, internal ticket redeem for the broker (service token), `internal` route kind.
958 unit tests pass locally; PostgreSQL integration test for the whole flow runs in CI. UI deferred to Phase 08.
Details: [`phase-gates/PHASE_07.md`](phase-gates/PHASE_07.md).

### 2026-10-19 — Phase 08: SSH broker and remote terminal (branch `phase-08-ssh-broker`, stacked on Phase 07)

- **`@qe/broker-core`**: ssh2 transport with a mandatory pinned host-key verifier, pinned algorithms, no forwards;
  error mapping; `qews.v1` terminal bridge (early-input queue, resize, Ctrl+C as `0x03`, backpressure, timers,
  idempotent close); session registry; development key-file credentials. `qews.v1` codec in `@qe/contracts`.
- **`apps/connection-broker`**: Origin + ticket-subprotocol upgrades, redeem before upgrade, per-session re-check of
  port/address/host key, PTY bridge, state reports, internal revocation, drain on SIGTERM.
- **Control plane**: broker state reports (audited, incl. host-key and address security events); revocation reaches
  the broker; `BROKER_PUBLIC_URL` for development.
- **IDE**: `qe-remote` extension — Connect to Remote System opens a remote terminal in the browser; desktop explains
  the Phase 10 sign-in.
- **Tests**: 1035 unit tests locally, including real SSH handshakes and a broker end-to-end suite against ssh2's
  in-process server; real OpenSSH container suite for CI.

Process notes: an `eslint --fix` once removed an optional call that ssh2 needs at runtime (window-change `accept`
can be undefined despite its type) — caught by the PTY test and restored with a justified exception.
Details: [`phase-gates/PHASE_08.md`](phase-gates/PHASE_08.md).

### 2026-10-24 — Dependency vulnerabilities (branch `fix/dependency-audit`)

In the new Ubuntu (WSL) clone, `npm audit fix --force` had been run: it "fixed" by downgrading Theia to 1.18/1.4/0.3.14,
mixing versions and adding packages, which raised the count to 82 and broke the IDE. That clone was restored to the
committed lockfile (the changes are saved in `~/audit-force-backup.patch`) and the real 59 findings (12 root packages)
fixed properly: Fastify 5.12.7, Electron 42.11.16 (eMudhra certificate advisory), lockfile updates (body-parser,
fast-uri, multer) and root `overrides` for transitive packages pinned by Theia's dependencies (DOMPurify in
`@theia/monaco-editor-core`, uuid under `react-tooltip` and `trash`, diff and serialize-javascript under `mocha`).
Result 12 findings (production 7). Typecheck, the Theia version guard and 958 unit tests pass.

Accepted, no upstream fix (review at each Theia upgrade):

- `decompress` (critical, all versions; via `@theia/cli` and `@theia/plugin-ext`): archive path traversal. Only
  pinned, checksum-verified plugin archives from `config/vscode-plugins.json` are extracted (ADR-012); users cannot
  install plugins from arbitrary archives.
- `@tootallnate/once` 1.1.2 (low; via `@vscode/proxy-agent`): the v2 fix changes the module's export shape.
- `zod` 3.x under `chromium-bidi` (high, dev only; puppeteer from `@theia/cli`): oversized-input memory exhaustion in
  a test tool that never validates untrusted input; not shipped.

Never use `npm audit fix --force` in this repo: it resolves by downgrading Theia.

### 2026-10-25 — Phase 08 brought up to `main` and run locally for the first time

`main` (dependency audit PR #12, test fix PR #13, WSL/Docker docs) merged into `phase-08-ssh-broker`; the only conflict
was this log. With Docker Engine in WSL the OpenSSH and PostgreSQL suites ran on the project PC for the first time and
found three test-fixture defects (OpenSSH image ignored its own sshd settings, a missing `closeOnBroker` in the
targets test, a Ctrl+C check matching the PTY echo). All fixed; 77/77 integration and 1035/1035 unit tests pass.
Details: [`phase-gates/PHASE_08.md`](phase-gates/PHASE_08.md).
