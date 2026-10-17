# 03 — Technology Stack and Version Policy

## 1. Stack

| Layer | Choice | Notes / alternatives |
|---|---|---|
| IDE platform | **Eclipse Theia** (`@theia/*`) | Browser + Electron targets from one app definition |
| Editor | Monaco (bundled by `@theia/monaco`) | |
| VS Code extensions | `@theia/plugin-ext`, `@theia/plugin-ext-vscode`, `@theia/vsx-registry` | Point registry to internal Open VSX mirror |
| Terminal | `@theia/terminal` (xterm.js + node-pty) | Our remote terminal reuses Theia terminal widget APIs where possible |
| Language | TypeScript (strict) | One language end-to-end |
| Runtime | Node.js **Active LTS** compatible with the pinned Theia | Verify Theia's `engines` field |
| Package manager | **npm workspaces** | Theia's CLI expects hoisted `node_modules`; pnpm only with `node-linker=hoisted` after a spike |
| Build orchestration | Turborepo or Nx (optional) | Caching for CI |
| HTTP framework | **Fastify** | `@fastify/websocket`, `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/helmet` |
| Validation | **Zod** (+ `zod-to-openapi` or `fastify-type-provider-zod`) | Single schema → types + runtime validation + OpenAPI |
| DB access | **Kysely** (typed SQL) or Drizzle | Prefer explicit SQL; avoid magic migrations |
| Migrations | `node-pg-migrate` or Drizzle Kit, SQL files reviewed | Expand/contract pattern |
| Database | PostgreSQL (supported major) | Managed in prod |
| SSH | **`ssh2`** behind `SshTransport` | Supports PTY, exec, SFTP, `hostVerifier`, agent, jump via `forwardOut` + `sock` |
| OIDC | `openid-client` | Auth code + PKCE; desktop uses loopback redirect (RFC 8252) |
| JWT/JWS | `jose` | Tickets, service tokens |
| Secrets | `SecretProvider` → Vault (`node-vault` or raw HTTP), Azure KV, AWS SM | Dev: file/env provider guarded off in prod |
| K8s client | `@kubernetes/client-node` | Runtime provider |
| Docker client | `dockerode` | Dev/local runtime provider |
| Logging | **pino** (JSON) with redaction paths | |
| Telemetry | OpenTelemetry JS SDK (`@opentelemetry/sdk-node`, auto-instrumentations) | OTLP exporter |
| Unit tests | **Vitest** | Theia extensions may need Mocha/Jest per Theia conventions — follow the generator |
| Integration tests | **Testcontainers** (PostgreSQL, OpenSSH server, Vault dev) | |
| E2E | **Playwright** (+ `@theia/playwright` page objects) | Run against browser and Electron |
| Load | **k6** (HTTP + WebSocket) | |
| Security scans | Semgrep/CodeQL (SAST), `npm audit`/OSV-Scanner, Trivy/Grype (images), Gitleaks (secrets), Checkov/kube-linter (IaC), OWASP ZAP (DAST) | |
| SBOM / signing | Syft (CycloneDX/SPDX), cosign | |
| Containers | Docker/BuildKit, multi-stage, non-root | |
| Deploy | Helm 3 charts; Argo CD or pipeline `helm upgrade` | |
| Desktop packaging | `electron-builder` | Code signing for Windows/macOS |

## 2. Version policy

1. **Pin exactly** (no `^`/`~`) all `@theia/*` packages to the **same** version.
2. Commit `package-lock.json`; CI uses `npm ci`.
3. `.nvmrc` + `"engines"` + `engine-strict=true` in `.npmrc`.
4. Base images pinned by **digest**; Renovate/Dependabot updates them via PR.
5. Theia upgrades: on a fixed cadence (monthly or quarterly), on a branch, with the full E2E suite
   for both browser and Electron targets. Read the Theia changelog's *Breaking Changes* section first.
6. Native modules (`node-pty`, `keytar`/`@theia/electron` deps) must be rebuilt for Electron
   (`theia rebuild:electron` / `electron-rebuild`). CI builds desktop on each target OS.
7. Record chosen versions and the verification date in `docs/ORG_DECISIONS.md`.

## 3. Things to verify in the Phase 00 spike (do not assume)

- [ ] The exact Theia package set required for: editor, explorer, terminal, search, SCM via VS Code git
      built-in, plugin host, Open VSX registry, preferences, output, problems/markers, debug.
- [ ] Theia's current RPC API name (`RpcConnectionHandler` / `ConnectionHandler`, frontend
      `ServiceConnectionProvider` / `WebSocketConnectionProvider`) for the pinned version.
- [ ] How to register a custom `FileSystemProvider` for a new URI scheme via `FileServiceContribution`.
- [ ] Which approach works best for a custom (broker-backed) terminal: (a) VS Code `Pseudoterminal`
      via a built-in plugin, (b) Theia `TerminalWidget` + custom backend/WS, (c) custom xterm widget.
- [ ] Base path support: running Theia under `/w/{workspaceId}/` behind a reverse proxy
      (asset URLs, WebSocket endpoint path, service worker, webviews' origin handling).
- [ ] Webview origin handling for VS Code extensions (Theia serves webviews from a separate origin
      pattern — configure `THEIA_WEBVIEW_EXTERNAL_ENDPOINT` accordingly).
- [ ] `ssh2` behaviour for: `hostVerifier` with SHA256 fingerprints, certificates (`*-cert-v01@openssh.com`),
      agent on Windows (`\\.\pipe\openssh-ssh-agent`) and macOS/Linux (`SSH_AUTH_SOCK`), jump hosts.
- [ ] Electron packaging on Windows (node-pty prebuilds, code signing).

Record results in ADRs (`05_ADR/`).
