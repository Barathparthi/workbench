# Project Log — QE Workspace

A dated record of what has been done in this repository, why, and what is still open. It starts from the
repository's initial state (the first commit). Newest entries go at the **bottom** of the log section; the
status snapshot at the top is kept current.

How to add an entry: date, phase, what changed (with commit or PR), decisions and deviations from the kit,
evidence, and open items. Release-level changes also go in `/CHANGELOG.md`.

---

## Status snapshot (updated 2026-10-17)

| Phase                                | State                                                                                       | Record                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 00 — Environment, decisions & spikes | **Gate proposed CONDITIONAL** — S1–S5 done, ADR-005/006 accepted; org answers + review open | [`phase-gates/PHASE_00.md`](phase-gates/PHASE_00.md) |
| 01 — Monorepo foundation             | **Done — gate PASS** (CI green, branch protection on)                                       | [`phase-gates/PHASE_01.md`](phase-gates/PHASE_01.md) |
| 02 — Theia product shell             | Not started (next)                                                                          | `02_PHASES/PHASE_02_THEIA_PRODUCT_SHELL.md`          |
| 03 – 19                              | Not started                                                                                 | `02_PHASES/`                                         |

Milestones: M1 (end of Phase 06) — not reached.

**Next actions**

1. Phase 00 gate conditions: send sections A8 and B–E of [`ORG_DECISIONS.md`](ORG_DECISIONS.md) (incl. D9,
   D12) to the owning teams, A8 with a licence review; hold the architecture review (tech lead + security)
   before Phase 05.
2. Decide how to carry the `ssh2` certificate patch (S4): `patch-package` + upstream PR is the recommendation.
3. Phase 02: Theia product shell on Theia 1.76.0, applying the S1, S2, S3 and S5 findings.
4. When a second maintainer joins: add "require a pull request + 1 approval" to the `main` ruleset.

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
