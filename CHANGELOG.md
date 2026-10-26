# Changelog

All notable changes to QE Workspace are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); entries come from Conventional Commits.
The narrative history (decisions, deviations, evidence) lives in [`docs/PROJECT_LOG.md`](docs/PROJECT_LOG.md).

## [Unreleased]

### Fixed

- Workspace router: opening `/w/{id}/` crashed the control plane (`set.map is not a function`) when the runtime sent
  exactly one `Set-Cookie`, as Theia does on its first page: undici returns a single header as a string. Both
  shapes are now scoped to `/w/{id}/`.
- Workspace router: WebSocket upgrades now keep the browser's `Host`. Theia 1.76 refuses a WebSocket whose Origin
  host differs from `Host`, so the IDE could never connect through `/w/{id}/`.
- Workspace runtime image: optional `--secret id=extra_ca,src=<ca.pem>` for builds behind a TLS-inspecting proxy.

### Security

- Dependency audit: 12 → 5 `npm audit` findings (all from the one remaining root cause, `decompress`). Scoped
  overrides: puppeteer/puppeteer-core 25.1.0 → 25.16.0 under `@theia/cli` (chromium-bidi 157.0.8090 drops the
  vulnerable zod 3), and `@tootallnate/once` 2.0.1 + `http-proxy-agent` 5.0.0 under `@vscode/proxy-agent`.

- Dependency audit: 59 → 12 `npm audit` findings with no Theia downgrade. Fastify 5.12.5 → 5.12.7, Electron
  42.11.10 → 42.11.16; lockfile updates for body-parser, fast-uri, multer; root `overrides` for DOMPurify in Monaco
  (3.4.17), uuid under react-tooltip and trash (11.1.1), and diff/serialize-javascript under mocha. Three advisories
  have no upstream fix yet and are accepted — see `docs/PROJECT_LOG.md` (2026-10-24).

### Added

- Phase 07 remote targets: `@qe/policy` SSRF guard and connection decisions; connection policies, credential
  references, targets and host keys (admin APIs, audited); role-filtered target list; remote sessions with single-use,
  Origin-bound tickets; internal ticket redeem for the broker.

- Phase 06 terminal hardening: QE terminal policy on Theia's terminal server (shell allowlist, open-terminal limit,
  `TERM`/`LANG` defaults), 10,000-line scrollback default, UTF-8 runtime locale, browser E2E suite for the terminal.

- Phase 05 workspace runtime and routing: `@qe/runtime-providers` (Docker, Kubernetes), workspace start/stop/events
  API with quota and audit, reconciler with idle stop, `/w/{id}/` HTTP + WebSocket router with membership checks and
  cookie scoping, runtime removal on delete, signed-in user in the IDE status bar, setuid-free runtime image.

- Phase 04 development identity and RBAC: `@qe/rbac` permission matrix and group → role mapping; OIDC login
  (code + PKCE) with server-side sessions, idle/absolute expiry and session-bound CSRF tokens; authorization on every
  route with audited denials; `/api/v1/me`; migration `0003_web_sessions`; Keycloak dev realm in compose; authz
  matrix and Keycloak integration tests; `ControlPlaneClient` in `@qe/client-sdk`.

- `.gitignore` for the Node/TypeScript/Theia/Electron monorepo, environment files and private keys.
- Phase 00 (partial): pinned toolchain — Node.js 24.22.0 LTS, TypeScript 5.9.3, Theia 1.76.0 candidate —
  and `docs/ORG_DECISIONS.md` with kit defaults marked as assumed.
- Phase 01 monorepo foundation:
  - npm workspaces, strict TypeScript project references, ESLint (typescript-eslint strict-type-checked,
    package boundaries, restricted `child_process`), Prettier, Vitest `unit`/`integration` projects with
    coverage gates.
  - Library packages `@qe/domain`, `contracts`, `rbac`, `policy`, `broker-core`, `secrets`,
    `runtime-providers`, `telemetry`, `client-sdk`, `test-utils`.
  - `@qe/domain`: `ErrorCodes` with HTTP statuses, `DomainError`, `assertNever`, workspace and remote-session
    state machines.
  - Lint proof tests and a workspace dependency-graph guard (`tests/lint/`).
  - `CLAUDE.md`, `AGENTS.md`, PR template, CODEOWNERS, CI workflow (ubuntu + windows), bootstrap scripts.
- Project documentation: `docs/PROJECT_LOG.md`, phase-gate records, ADR-011, risks R14–R15.
- Phase 00 spike S1 (`spikes/s1-theia-hello`): one Theia 1.76.0 extension running in a browser app and an
  Electron app, with Playwright checks; report in `docs/spikes/S1_THEIA_HELLO.md`. Theia pinned to 1.76.0.

- Phase 00 spike S2 (`spikes/s2-proxy`): Theia behind a Fastify reverse proxy at `/w/{id}/` and on a
  subdomain, with Playwright checks and a two-workspace reconnect test; report in
  `docs/spikes/S2_REVERSE_PROXY.md`. ADR-005 accepted: path-based routing.
- Phase 00 spike S5 (`spikes/s5-openvsx`): Open VSX availability checker and a path-filtered CI workflow
  (`spike-s5-openvsx`) that runs it on GitHub's runners; report and proposed extension allowlist in
  `docs/spikes/S5_OPEN_VSX.md`.

- Phase 00 spike S4 (`spikes/s4-ssh2`): local OpenSSH target/bastion + Vault SSH CA environment, 20 `ssh2`
  checks and a 5-line `ssh2` patch for OpenSSH user certificates; report in `docs/spikes/S4_SSH2.md`; ADR-002 and
  ADR-007 addenda.

- Phase 00 spike S3 (`spikes/s3-remote`): remote terminal + remote files built twice (VS Code web extension vs
  Theia frontend extension) against a stub session broker, with Playwright checks in browser and Electron;
  report in `docs/spikes/S3_REMOTE_TERMINAL_FS.md`. ADR-006 accepted: Theia frontend extension. Risk R17 added.

- Phase 02 Theia product shell:
  - `apps/ide-browser` and `apps/ide-electron` on Theia 1.76.0 with identical extension sets (no in-IDE
    marketplace) and `extensions/qe-core`: QE commands, `QeEnvironment` (hosted / local-web / desktop from
    validated `QE_*` variables), `qe.*` preferences, mode status bar item, QE welcome page, About dialog, favicon.
  - Built-in VS Code plugins pinned by version and SHA-256 (`config/vscode-plugins.json`), downloaded, verified
    and unpacked by `scripts/plugins.ts`; `vscode-plugins` workflow.
  - Workspace runtime development image (`images/workspace-runtime`, UID 1000, digests pinned).
  - Playwright smoke tests (`npm run test:e2e`) and the `ide` workflow (runtime image + smoke tests);
    Theia/Electron version guard (`npm run check:theia-versions`); ADR-012.

- Phase 03 control plane and database:
  - `@qe/contracts`: Zod v1 DTOs (workspaces, templates), `ProblemDetails`, audit metadata allowlist.
  - `apps/control-plane`: Fastify 5 server with fail-fast config, problem+json errors, request IDs, redacting
    logger, rate limits, health endpoints, graceful shutdown and generated `openapi.json`; workspace API
    (list/create/get/update/delete, templates).
  - PostgreSQL schema `0001_init.sql` and template seed, checksummed migration runner, Kysely repositories,
    hash-chained append-only audit log.
  - `deploy/compose/docker-compose.dev.yml` (PostgreSQL 18.6), Testcontainers integration tests and the CI job
    `integration + coverage`.

- `docs/LOCAL_DEVELOPMENT.md`: system requirements and a step-by-step guide to continue development on a local
  machine (Linux, macOS, Windows).

### Changed

- Phase 00 gate record: all spikes done, decision proposed CONDITIONAL (org answers, architecture review).
- Electron raised from 42.8.1 to 42.11.10 (root `overrides`) for four high-severity advisories.
- CI: the `verify` job runs unit tests without coverage; the new `integration + coverage` job enforces coverage.

### Security

- Invalid `QE_*` configuration stops the IDE backend (exit 78); the runtime image defaults to hosted mode.
- No registry traffic from the IDE: `@theia/vsx-registry` is excluded and the smoke test asserts same-origin requests.
- Control plane: every route declares permission, audit and rate limit; authentication fails closed; foreign
  Origins are refused on unsafe methods; the application database role cannot change the schema or rewrite audit
  events; audit writes fail closed.

- Phase 01 gate PASS: branch protection ruleset on `main` verified.

- `.gitignore` and ESLint ignores cover Theia's esbuild output (`gen-esbuild.*.mjs`); Prettier skips `spikes/`.

### Initial state

- `1895cc9` — QE Workspace Production Implementation Kit v2 (documentation only).
