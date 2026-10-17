# Changelog

All notable changes to QE Workspace are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); entries come from Conventional Commits.
The narrative history (decisions, deviations, evidence) lives in [`docs/PROJECT_LOG.md`](docs/PROJECT_LOG.md).

## [Unreleased]

### Added

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

### Changed

- Phase 01 gate PASS: branch protection ruleset on `main` verified.

- `.gitignore` and ESLint ignores cover Theia's esbuild output (`gen-esbuild.*.mjs`); Prettier skips `spikes/`.

### Initial state

- `1895cc9` — QE Workspace Production Implementation Kit v2 (documentation only).
