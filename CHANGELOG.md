# Changelog

All notable changes to QE Workspace are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); entries come from Conventional Commits.
The narrative history (decisions, deviations, evidence) lives in [`docs/PROJECT_LOG.md`](docs/PROJECT_LOG.md).

## [Unreleased]

### Added

- Personal targets in the desktop app and in local web mode: hosts from `~/.ssh/config` (and
  `~/.qe-workspace/ssh_hosts`) reached through an SSH broker embedded in the IDE backend, with ssh-agent or key files
  (passphrases asked in the IDE), OpenSSH `known_hosts` and a local audit log. Terminals and remote folders work the
  same for personal and managed targets.
- Trust on first use for personal hosts: the host's fingerprint is shown, and the key is trusted once, trusted and
  saved to `~/.qe-workspace/known_hosts`, or refused; a changed key is refused as OpenSSH does.
- Desktop sign-in: "QE: Sign In to QE Workspace" signs in through the system browser (OIDC authorization code + PKCE,
  loopback redirect). The refresh token is kept with the OS keychain (Electron `safeStorage`) and never written in
  plain text; managed targets then work in the desktop app through its backend.
- Control plane: accepts the desktop client's IdP access tokens as bearer tokens when `OIDC_DESKTOP_CLIENT_ID` is set
  (signature, issuer, audience, authorized party and expiry checked); `GET /auth/desktop` tells the desktop app where
  to sign in. Broker: accepts a stream without an Origin when its ticket was issued to such a token. The dev realm has
  the `qe-workspace-desktop` client.
- Local web mode serves nothing without its sign-in cookie: the link with the run's token (shown by the launcher, or
  written to `~/.qe-workspace/local-web-url`) sets an HttpOnly, SameSite=Strict cookie; pages, bundles and WebSocket
  handshakes are refused without it, and under any Host name but loopback. The backend refuses to listen on anything
  but loopback outside the local-web container.
- `scripts/qe-workspace-local` (bash) and `qe-workspace-local.ps1`: QE Workspace in a container for one folder,
  published on 127.0.0.1 only, `~/.ssh` read-only, ssh-agent optional (`deploy/compose/docker-compose.local-web.yml`).

- Organisation-managed settings for the desktop app and local web (ADR-013): Windows registry policy
  (`HKLM\Software\Policies\QEWorkspace`) or `policy.json` on macOS and Linux — control plane URL, the deny list and
  trust-on-first-use switch for personal targets, Open VSX URL, telemetry. Invalid policies stop the app.
- Desktop installers (`npm run package -w @qe/ide-electron`): Windows NSIS, macOS dmg, Linux AppImage and deb, with the
  built-in plugins; signing and notarization from environment variables only. Nightly `desktop` workflow builds and
  smoke-tests them on Linux, Windows and macOS.
- "QE: Add SSH Host…" (desktop and local web, also the last entry of the host picker): `user@host:port` and a
  name, saved to `~/.qe-workspace/ssh_hosts`; `~/.ssh/config` is never changed.
- Parity suite (`tests/parity`, Playwright projects `parity-hosted`, `parity-local-web`, `parity-desktop`): the same
  scenarios in every mode — QE commands, explorer, edit and save, terminal, Ctrl+C, webview, remote terminal, remote
  edit and save, links out of the remote folder. Desktop runs nightly on Linux, Windows and macOS.
- Local web: webviews (Markdown preview, plugin panels) work, on their own `<id>.webview.localhost` origin; the sign-in
  link uses `localhost`.

### Security

- `decompress` 4.2.1 (Theia's plugin unpacking; no fixed release for archive entries and symlink chains that write
  outside the target, GHSA-mp2f-45pm-3cg9 and three others) is replaced for every consumer by
  `vendor/decompress-compat`, its CommonJS API on the patched `@xhmikosr/decompress` 11.1.4 (root `overrides`).
- `deepmerge` 4.3.1 (GHSA-gcqx-w48m-w2h4, low, no fixed release) is kept: Theia merges only its own configuration
  defaults with it, never user or network input.

### Fixed

- Remote files: a save over a change made on the server could overwrite it without asking. SFTP mtimes have whole
  seconds and the browser auto-saves after 1 s, so an auto-save and a change on the server often fell in one second,
  which Theia's check does not count. Remote files now count any other mtime or size as changed, and the save asks.
- Terminals: each new browser, device or private window started a terminal that kept running after the page closed,
  and after 10 the IDE refused every new terminal until the workspace restarted. A fresh layout now starts no terminal,
  and a terminal no page has been attached to for 30 minutes is ended (`QE_TERMINAL_DETACHED_MINUTES`, 1–1440).
- Remote files: opening a link that points outside the remote folder now says so, instead of doing nothing.
- Embedded broker: an unexpected failure (`INTERNAL_ERROR`) is logged with its kind and message, never data or
  secrets.
- Desktop app: SSH connections failed with "The remote session could not be opened" (`INTERNAL_ERROR`). Electron's
  Node has no ChaCha20-Poly1305 and ssh2 refused the pinned cipher list; the pinned lists are now limited to what the
  runtime supports, never extended.
- CI `desktop`: empty signing secrets are unset (macOS took an empty `CSC_LINK` for a certificate path); installers are
  uploaded only on a manual run with `upload` or `sign`, for 3 days (the artifact storage quota was full).
- CI: the runtime image's local-web check starts the container as the launcher does (published on loopback, with a
  sign-in token) and checks the cookie flow, instead of expecting an open page.
- "QE: Sign Out" (hosted sign-in) is offered only in hosted mode; the desktop app has "QE: Sign Out of QE Workspace".

- Broker: SSH connections use `TCP_NODELAY`. ssh2 leaves Nagle's algorithm on, so each SFTP round trip and
  terminal exchange waited ~45 ms for a delayed ACK (remote save p95 1344 → 142 ms).
- Sessions of a broker that restarted no longer stay open: at startup the broker asks the control plane to close
  them (audited, reason `broker_restarted`), retrying until it answers, and opens no session before that.
- Tests: SSH test keys are drawn again when ssh2 1.17.0 generates one its own parser rejects (~0.6 % of ed25519
  keys), which made suites fail at random; the browser smoke test waits for the shell before typing.

- Workspace router: opening `/w/{id}/` crashed the control plane (`set.map is not a function`) when the runtime sent
  exactly one `Set-Cookie`, as Theia does on its first page: undici returns a single header as a string. Both
  shapes are now scoped to `/w/{id}/`.
- Workspace router: WebSocket upgrades now keep the browser's `Host`. Theia 1.76 refuses a WebSocket whose Origin
  host differs from `Host`, so the IDE could never connect through `/w/{id}/`.
- Workspace router: `/w/{id}/` gets its own Content Security Policy (helmet defaults plus `unsafe-eval`,
  `wasm-unsafe-eval`, `blob:` workers and images). The API's `script-src 'self'` stopped the IDE at startup
  (ajv compiles preference schemas with `new Function`); API routes keep the strict policy.
- Workspace runtime image: optional `--secret id=extra_ca,src=<ca.pem>` for builds behind a TLS-inspecting proxy.
- Workspace runtime image: builds every IDE extension before bundling. It built only `qe-core`, so since Phase 08
  the IDE in a workspace stopped at startup (`Dynamic require of "@qe/theia-qe-remote/…" is not supported`).
- Workspace runtime image: native modules compile against the Node headers in the base image instead of downloading
  them from nodejs.org (a stalled download hung a build for 25 minutes).
- Workspace router CSP: `connect-src` allows `data:` (Monaco's inlined WebAssembly) and the broker's ws/wss origin
  when `BROKER_PUBLIC_URL` is set, so remote terminals can stream in development.
- Remote terminals open at the size the IDE requested: the control plane stores it with the session (migration
  `0004_session_terminal_size`) and hands it to the broker, which no longer hard-codes 80×24.

### Security

- Dependency audit: 12 → 5 `npm audit` findings (all from the one remaining root cause, `decompress`). Scoped
  overrides: puppeteer/puppeteer-core 25.1.0 → 25.16.0 under `@theia/cli` (chromium-bidi 157.0.8090 drops the
  vulnerable zod 3), and `@tootallnate/once` 2.0.1 + `http-proxy-agent` 5.0.0 under `@vscode/proxy-agent`.

- Dependency audit: 59 → 12 `npm audit` findings with no Theia downgrade. Fastify 5.12.5 → 5.12.7, Electron
  42.11.10 → 42.11.16; lockfile updates for body-parser, fast-uri, multer; root `overrides` for DOMPurify in Monaco
  (3.4.17), uuid under react-tooltip and trash (11.1.1), and diff/serialize-javascript under mocha. Three advisories
  have no upstream fix yet and are accepted — see `docs/PROJECT_LOG.md` (2026-10-24).

### Added

- Phase 09 remote filesystem: path confinement (lexical + server realpath, re-checked per call) and SFTP file
  operations in `@qe/broker-core` (10 MB, 5,000 entries, 15 s, ETag conflicts, atomic save, capped recursive delete);
  `POST /api/v1/sessions/{id}/fs/{op}` on the control plane (owner only, `file_write` per policy, changes and
  read-side escapes audited, never contents) and files-sessions on the broker; `qe-ssh://` file system with
  "Open Remote Folder…", `[target]` labels, polling for server-side changes and Theia's conflict dialog in the IDE;
  traversal corpus in `tests/security`; hosted end-to-end Playwright project.

- Phase 08 SSH broker: `@qe/broker-core` (ssh2 transport with pinned host keys, terminal bridge), `qews.v1` codec,
  `apps/connection-broker` (ticketed WebSocket stream to SSH, revocation, drain), broker state reports and revocation in
  the control plane, `qe-remote` IDE extension (Connect to Remote System).

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
