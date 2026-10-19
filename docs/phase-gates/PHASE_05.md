# Phase Gate — Phase 05: Workspace Runtime and Routing

**Date:** 2026-10-19 · **Branch:** `phase-05-workspace-runtime` (local; owner pushes and merges) · **Reviewers:** @Barathparthi

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_05_WORKSPACE_RUNTIME_AND_ROUTING.md`.
Decisions: ADR-004 (pod per workspace), ADR-005 (path routing `/w/{id}/`).

## Deliverables

| Deliverable                                        | Status                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `WorkspaceRuntimeProvider` + Docker + Kubernetes   | done — typed Docker Engine and Kubernetes API clients (no SDK dependencies); idempotent `ensureStarted`/`ensureStopped`/`destroy`; volume/PVC survives stop                                                                                                                                                                                                                   | `packages/runtime-providers/src`, 20 unit tests                                    |
| Hardened runtimes                                  | done — Docker: UID 1000, `CapDrop ALL`, `no-new-privileges`, memory/CPU/PIDs limits, tmpfs `/tmp`, no host mounts or Docker socket, port published on 127.0.0.1 only; Kubernetes: PSS-restricted pod (non-root, no escalation, drop ALL, RuntimeDefault seccomp), no service-account token, no service links, bounded ephemeral storage; image without setuid/setgid binaries | `ideContainerSpec`, `podManifest`, Dockerfile                                      |
| Lifecycle API (start/stop/SSE), idempotent, quota  | done — compare-and-set transitions, background bring-up with readiness probe and timeout, `FAILED` with a short reason, per-user running quota (`QUOTA_EXCEEDED`), `WORKSPACE_START`/`WORKSPACE_STOP` audit, SSE `/api/v1/workspaces/{id}/events`                                                                                                                             | `workspace-lifecycle.ts`, `routes/lifecycle.ts`, `lifecycle.int.test.ts`           |
| Reconciler + idle stop                             | done — single replica (advisory lock); repairs lost runtimes, stuck STARTING/STOPPING, interrupted deletes, orphaned containers; stops idle workspaces                                                                                                                                                                                                                        | `reconciler.ts`, `lifecycle.int.test.ts`                                           |
| Workspace router `/w/{id}/*` (HTTP + WebSocket)    | done — session + membership + RUNNING checked on every request and upgrade; Origin required on upgrades and unsafe methods; platform cookies, `Authorization` and CSRF header never reach the runtime; runtime `Set-Cookie` scoped to `/w/{id}/` (S2 finding); 308 `/w/{id}` → `/w/{id}/`; sockets closed on logout, stop and shutdown; activity recorded (debounced)         | `router/workspace-router.ts`, `workspace-router.test.ts` (real upstream, 14 tests) |
| Git clone on first start                           | done — URL/ref passed as positional arguments (no shell interpolation), only into an empty project, failed clone removes the volume                                                                                                                                                                                                                                           | `CLONE_SCRIPT`, provider tests                                                     |
| Delete removes runtime and volume                  | done — DELETING → destroy → DELETED; failures retried by the reconciler                                                                                                                                                                                                                                                                                                       | `workspace-service.ts`                                                             |
| IDE shows the signed-in user (moved from Phase 04) | done — hosted mode: status bar `$(account) user`, Sign Out command                                                                                                                                                                                                                                                                                                            | `extensions/qe-core/src/browser/qe-user-status.ts`                                 |

## Validation (real output, trimmed)

Local: Windows 11, Node 24.22.0, **no Docker** (unit tests here; Docker-based tests in CI).

```text
$ npm run typecheck        → exit 0
$ npm run lint             → 0 problems
$ npm run format:check     → All matched files use Prettier code style!
$ npx vitest run --project unit
 Test Files  36 passed (36)
      Tests  771 passed (771)      (authz matrix: 153 cases incl. start/stop/events and /w/{id}/*)
$ npm run openapi:generate -w @qe/control-plane → wrote openapi.json (start, stop, events, /w routes)
```

Not run locally: `lifecycle.int.test.ts`, the other `*.int.test.ts` suites (PostgreSQL via Testcontainers), and a
real Docker/Kubernetes start of the runtime image. The `integration + coverage`, `runtime image` and `smoke` CI jobs
cover the first two; an end-to-end M1 run (login → start → IDE through `/w/{id}/` → terminal) needs Docker — see
Known limitations.

## Security review

- **Threats touched**: T9 (runtime gets no platform credentials — cookies/Authorization stripped, env has no
  secrets), T12 (WebSocket hijacking — Origin + session + membership on every upgrade), T14 (workspace-to-workspace —
  membership per request, cookie path scoping, separate containers/pods and volumes), T15 (container escape — non-root,
  no capabilities, no new privileges, no setuid binaries, restricted PSS), T16 (resource exhaustion — CPU/memory/PIDs
  /ephemeral limits, per-user quota, start rate limit 10/min), T11 (command injection — clone arguments positional).
- **Negative tests**: non-member → 404 (HTTP and WS), not running → 409, no session → 401, foreign/missing Origin on
  upgrade and unsafe methods → 403, invalid workspace ids never reach resource names, hostile git URL/ref, viewer
  cannot start, quota, failed pull, failed clone cleans up, timeout, lost runtime, orphan runtime.

## Operational review

- Audit: `WORKSPACE_START`, `WORKSPACE_STOP` (reason `user` / `idle` / `runtime_lost` / `start_failed` /
  `stuck_stopping`), `WORKSPACE_DELETE`.
- Logs: reconciler actions per pass; background failures with workspace id; no request bodies or terminal bytes.
- Metrics/traces: Phase 13.

## Deviations from the guide (recorded)

- Docker and Kubernetes are reached through small typed HTTP clients instead of `dockerode`/`@kubernetes/client-node`
  (fewer dependencies, no untyped major-version churn); both are covered by fakes in unit tests.
- The Docker root filesystem stays writable: Theia keeps user settings under `/home/qe/.theia`. Revisit with a
  settings volume in Phase 14.
- Readiness uses an HTTP probe from the control plane (`GET /` < 500) in addition to the pod's TCP probes.
- SSE events are per replica; clients also see state in `GET /workspaces/{id}` (multi-replica fan-out: Phase 16).
- The status-bar user display calls the API with `fetch` instead of `@qe/client-sdk` (ESM package in a CommonJS
  Theia extension cannot be verified without the native Theia build on this machine).

## Known limitations & follow-ups

- **M1 end-to-end** (browser → Keycloak login → start → IDE through the router → terminal) needs Docker on the
  machine or a CI job with Docker + the runtime image; add a Playwright `m1.spec.ts` once either exists.
- Lab-network egress blocking for the Docker network is a host firewall concern; Kubernetes NetworkPolicies: Phase 16.
- `WORKSPACE_OPEN` audit (first IDE open per session) not emitted yet.

## Decision

- [ ] PASS
- [x] CONDITIONAL — pending CI integration results and an M1 end-to-end run with Docker
- [ ] FAIL
