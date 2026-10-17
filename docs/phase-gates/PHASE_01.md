# Phase Gate — Phase 01: Monorepo Foundation

**Date:** 2026-10-17 · **Branch/PRs:** `claude/gallant-goldberg-v788zv` (commits `cf57845`, `ff71118`; PR not
opened yet) · **Reviewers:** pending (1 human review required)

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_01_MONOREPO_FOUNDATION.md`.

## Deliverables

| Deliverable                                                                                | Status                                                                                         | Evidence                                                                  |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Monorepo layout per `01_ARCHITECTURE/04`                                                   | done (library packages; `apps/`, `extensions/`, `images/`, `deploy/` arrive with their phases) | `packages/`, `tests/`                                                     |
| Root tooling: npm workspaces, TS project references, ESLint + boundaries, Prettier, Vitest | done                                                                                           | `package.json`, `tsconfig.*.json`, `eslint.config.js`, `vitest.config.ts` |
| Ten empty-but-compiling packages                                                           | done                                                                                           | `packages/*`                                                              |
| `@qe/domain` seeded with errors and state machines                                         | done                                                                                           | `packages/domain/src`                                                     |
| `CLAUDE.md`, `AGENTS.md`, PR template, CODEOWNERS, `.editorconfig`, `.gitattributes`       | done                                                                                           | repo root, `.github/`                                                     |
| CI workflow: install, typecheck, lint, unit test, build                                    | done, **not yet run on GitHub**                                                                | `.github/workflows/ci.yml`                                                |
| `docs/` skeleton                                                                           | done — kit kept in place instead of copied (see project log)                                   | `docs/`                                                                   |
| Developer bootstrap scripts                                                                | done (`.sh` run on Linux; `.ps1` not run)                                                      | `scripts/`                                                                |
| Domain state-machine tests (all transitions)                                               | done — every pair: 64 workspace + 100 session                                                  | `packages/domain/src/__tests__`                                           |
| Lint test proving a forbidden import fails                                                 | done                                                                                           | `tests/lint/boundaries.test.ts`                                           |

## Validation (real output, trimmed)

Fresh install (`node_modules`, `dist` and caches removed first), Linux, Node 24.22.0:

```text
$ node --version
v24.22.0
$ npm --version
11.19.1
$ npm ci
added 196 packages, and audited 208 packages in 3s
4 high severity vulnerabilities
[exit 0]
$ npm run typecheck
> tsc -b tsconfig.build.json
[exit 0]
$ npm run lint
> eslint . --max-warnings=0
[exit 0]
$ npm run format:check
Checking formatting...
All matched files use Prettier code style!
[exit 0]
$ npm run test:unit -- --coverage
 RUN  v5.0.5 /home/user/workbench
      Coverage enabled with v8
 Test Files  14 passed (14)
      Tests  277 passed (277)
=============================== Coverage summary ===============================
Statements   : 100% ( 29/29 )
Branches     : 100% ( 9/9 )
Functions    : 100% ( 9/9 )
Lines        : 100% ( 29/29 )
================================================================================
[exit 0]
$ npm run test:integration
No test files found, exiting with code 0
[exit 0]
$ npm run build
> npm run build --workspaces --if-present
[exit 0]
```

Tests per file: session-state 104, workspace-state 68, workspace-graph 40, boundaries 33, errors 22,
contracts 2, the eight other skeleton packages 1 each.

### Boundary rule demonstrably blocks a forbidden import

A forbidden import was planted in real source files, then removed:

```text
$ npm run lint   # domain → broker-core and child_process in client-sdk planted

/home/user/workbench/packages/client-sdk/src/run.ts
  1:1  error  'node:child_process' import is restricted from being used. Only runtime-providers, broker-core and the qe-runner backend may spawn processes (04_REPO_STRUCTURE_AND_STANDARDS §2)  no-restricted-imports

/home/user/workbench/packages/domain/src/index.ts
  25:40  error  domain must not depend on broker-core — see the dependency rules in 01_ARCHITECTURE/04_REPO_STRUCTURE_AND_STANDARDS.md §1  boundaries/dependencies

✖ 2 problems (2 errors, 0 warnings)
[exit 1]

$ npx vitest run tests/lint/workspace-graph.test.ts   # undeclared @qe/rbac import planted in client-sdk
 FAIL  |unit| tests/lint/workspace-graph.test.ts > packages/client-sdk > declares every workspace package its sources import
AssertionError: expected [ '@qe/rbac' ] to deeply equal []
```

## Security review

- Threats touched: none directly (no runtime code). Supply-chain hygiene groundwork for Phase 15.
- Controls added: package boundaries enforced by lint (keeps `secrets`, `broker-core` and
  `runtime-providers` out of extensions and the client SDK); `child_process` restricted to
  process-owning packages; `eval`/`new Function` banned; `no-explicit-any`; exact dependency versions
  and a committed lockfile; CI actions pinned by commit SHA with a read-only `GITHUB_TOKEN` and
  `persist-credentials: false`.
- Negative tests: forbidden imports (12 package pairs + relative escape + test-file import), restricted
  `child_process`, `eval`, illegal state transitions, unknown error codes.
- `npm audit`: 4 high, all one advisory — `braces` (stack-exhaustion DoS, GHSA-vfj7-8cjw-p6xm) pulled in by
  eslint-plugin-boundaries via micromatch. Dev-only, patterns come from our own config, no upstream fix.
  The critical `handlebars` advisories from the same plugin are fixed by an `overrides` entry (4.7.10).
  Tracked as risk R14.

## Operational review

- Metrics / spans / logs: n/a (no services yet).
- Audit events: n/a.
- Alerts & runbooks: n/a.

## Parity (browser / local web / desktop)

- n/a for this phase. The workspace-package conventions (ESM libraries; Theia extensions get their own
  CommonJS tsconfig) are recorded in ADR-011 for Phase 02.

## Known limitations & follow-ups

- **CI not yet run on GitHub.** Windows has not been exercised (exit criterion: Linux **and** Windows).
- **Branch protection on `main` not enabled** (repository setting; needs the owner).
- `scripts/bootstrap.ps1` untested on Windows.
- `npm run build` re-runs `tsc -b` per workspace; acceptable now, revisit (Turborepo/Nx or a single
  `tsc -b`) when the Theia apps join in Phase 02.
- Phase 00 gate has not passed (prerequisite) — see `PHASE_00.md` and risk R15.

## Decision

- [ ] PASS
- [x] **CONDITIONAL** — conditions: (1) `ci` workflow green on ubuntu and windows for this branch's PR —
      owner: repository owner, by first PR; (2) branch protection enabled on `main` — owner: repository
      owner, before Phase 02 merges.
- [ ] FAIL
