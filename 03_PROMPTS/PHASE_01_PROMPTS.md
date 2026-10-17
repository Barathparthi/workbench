# Prompt Pack — Phase 01: Monorepo Foundation

Phase guide: `02_PHASES/PHASE_01_MONOREPO_FOUNDATION.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P01.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P01.1 … P01.6 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P01.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 01 — Monorepo Foundation
Read docs/phases/PHASE_01_MONOREPO_FOUNDATION.md (copy of the kit's phase guide) fully before anything else.
GOAL: Create a buildable, lint-clean, tested npm-workspaces monorepo with boundaries and CI.
IN SCOPE: root config; packages/* skeletons; .github/workflows/ci.yml; docs/
OUT OF SCOPE (do not touch): Theia apps (Phase 02); any feature logic
ACCEPTANCE: Fresh clone passes all commands on Linux and Windows; CI green; boundary rule blocks a forbidden import.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 01`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P01.1 — Root tooling

```text
Create root package.json (npm workspaces), .nvmrc, .npmrc (engine-strict, save-exact), .editorconfig,
.gitattributes (eol=lf), tsconfig.base.json (strict options from the phase guide), tsconfig.build.json with
project references, Prettier config. Run npm install and show the lockfile was created.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P01.2 — Package skeletons

```text
Create packages domain, contracts, rbac, policy, broker-core, secrets, runtime-providers, telemetry, client-
sdk, test-utils with package.json, tsconfig, src/index.ts and one trivial test each. Ensure `npm run
typecheck` and `npm run build` pass.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P01.3 — Domain primitives

```text
Implement packages/domain: ErrorCodes, DomainError, assertNever, WorkspaceState + canTransition, SessionState
+ canTransition exactly as in the phase guide/architecture. Add exhaustive tests for every legal and illegal
transition.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P01.4 — Lint + boundaries

```text
Configure ESLint flat config with typescript-eslint strict-type-checked, no-explicit-any, no-floating-
promises, no-restricted-imports for child_process outside allowed packages, and eslint-plugin-boundaries
encoding the dependency rules from docs/architecture/04. Add a fixture proving a forbidden import fails lint.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P01.5 — Vitest

```text
Configure Vitest projects `unit` and `integration` with coverage thresholds (domain/rbac/policy/broker-core
90%, others 75%). Add npm scripts test:unit and test:integration.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P01.6 — Repo hygiene + CI

```text
Add CLAUDE.md, AGENTS.md, PR template, CODEOWNERS from the kit templates; copy architecture docs to docs/. Add
.github/workflows/ci.yml verify job (npm ci, typecheck, lint, test:unit, build) with actions pinned by SHA and
least-privilege permissions. Add scripts/bootstrap.sh and scripts/bootstrap.ps1.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm ci
npm run typecheck
npm run lint
npm run test:unit -- --coverage
npm run build
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Fresh clone passes all commands on Linux and Windows; CI green; boundary rule blocks a forbidden import.
