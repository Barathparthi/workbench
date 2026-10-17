# ADRs

## ADR-001 — Eclipse Theia as IDE platform
**Context**: Need VS Code-like IDE in browser and desktop, extensible, self-hostable. **Decision**: Theia (browser + Electron targets, VS Code extension compatibility via Open VSX). **Alternatives**: code-server/OpenVSCode Server (browser-first, weaker desktop/product customization story, licensing/branding constraints), building on Monaco directly (too much to rebuild). **Consequences**: + one codebase for both modes, DI extension model; − Theia upgrade churn, internal API changes, not all MS extensions available.

## ADR-002 — Broker SSH from trusted backend
**Decision**: Hosted SSH only via the connection broker; browser gets single-use tickets and a WS stream; runtimes have no lab egress. **Consequences**: + central policy, host-key checks, audit, revocation; − broker is security-critical and must be capacity-planned.

## ADR-003 — Modular monolith
**Decision**: Deployables: control-plane, broker, runtime image, desktop app. Strict package boundaries enable later splits. **Consequences**: + simpler ops/debugging; − discipline required on boundaries (lint-enforced).

## ADR-004 — Pod per workspace
**Decision**: Each running workspace = one pod + PVC (hosted); Docker container + volume (local/dev). **Alternatives**: multi-user shared Theia backend (weak isolation), VMs per workspace (cost/latency; consider later via Kata). **Consequences**: + isolation, quotas; − cold-start latency (mitigate with image pre-pull, idle stop/resume).

## ADR-005 — Workspace routing (Proposed)
**Options**: (a) path `/w/{id}/` through control-plane router; (b) subdomain `{id}.ws.<corp>` with wildcard TLS. **Decision criteria**: Theia base-path support, webview origin isolation, cookie scoping, certificate management. **Decide** after spike S2.

## ADR-006 — Remote terminal & FS approach (Proposed)
**Options**: (A) VS Code API plugin (Pseudoterminal + FileSystemProvider), (B) Theia frontend extension widget + FileServiceContribution, (C) standalone xterm widget. **Must satisfy**: P9 (no SSH reachability from runtime), browser/Electron parity, upgrade resilience. **Decide** after spike S3.

## ADR-007 — Short-lived SSH certificates
**Decision**: Default credential = ephemeral key signed by Vault SSH CA (TTL ≤ 15 min, user principal). Fallback: Vault-stored key per target. **Consequences**: + no long-lived keys, per-user attribution on targets; − targets must trust CA (onboarding script).

## ADR-008 — Shared broker-core
**Decision**: Same library for hosted broker and embedded (desktop/local) broker with injected TargetSource/CredentialSource/HostKeyStore/AddressGuard/AuditSink. **Consequences**: + parity, one tested SSH stack; − careful dependency boundaries.

## ADR-009 — npm workspaces
**Decision**: npm workspaces (Theia CLI expects hoisted node_modules). pnpm only with hoisted linker after spike. **Consequences**: simpler Theia builds; slower installs mitigated by CI cache.

## ADR-010 — Internal Open VSX mirror
**Decision**: Extensions only from an internal Open VSX instance with an allowlist; no public marketplace in hosted builds. **Consequences**: + supply-chain control; − mirror operations and extension request process.

## ADR-011 — Workspace package conventions (ESM, source export condition, declared graph)
**Status**: Accepted — implemented in Phase 01 on 2026-10-17; ratify in the Phase 01 PR review. **Context**: The kit's package template points `main`/`types` at `dist`, so tests and lint would need a build first and could silently read stale output; an unresolvable workspace import is treated as external by the boundaries plugin and would slip past the dependency rules. **Decision**: Library packages in `packages/*` are ESM (`"type": "module"`, `NodeNext`). Each exports `{ "@qe/source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }`; TypeScript (`customConditions`), Vitest (`resolve.conditions`) and the ESLint import resolver (`conditionNames`) use `@qe/source`, Node uses `dist` at runtime. A workspace dependency is declared in three places — the import, `package.json` `dependencies`, `tsconfig.json` `references` — and `tests/lint/workspace-graph.test.ts` enforces agreement, because TypeScript does not fail on a missing reference when it can resolve the source. Theia extensions (Phase 02) keep CommonJS + decorators in their own `tsconfig.theia.json`. **Alternatives**: `paths` aliases (duplicate the graph, leak into emitted code); build-before-test (slow, stale-output risk). **Consequences**: + lint/test work on a fresh clone, one source of truth per package, runtime unaffected; − the custom condition must be repeated in each tool's config, and adding a dependency touches three files (guarded by the test).
