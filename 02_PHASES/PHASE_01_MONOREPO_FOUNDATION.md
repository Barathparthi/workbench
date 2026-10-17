# Phase 01 — Monorepo Foundation

| | |
|---|---|
| **Goal** | A buildable, lint-clean, tested monorepo skeleton with CI, ready for every later phase |
| **Duration** | 3–4 days |
| **Prerequisites** | Phase 00 gate PASS; versions pinned |
| **Prompt pack** | `03_PROMPTS/PHASE_01_PROMPTS.md` |

## Deliverables
- Repository `qe-workspace` with the layout from `01_ARCHITECTURE/04_REPO_STRUCTURE_AND_STANDARDS.md`.
- Root tooling: npm workspaces, TypeScript project references, ESLint (+ boundaries), Prettier, Vitest.
- Empty-but-compiling packages: `domain`, `contracts`, `rbac`, `policy`, `broker-core`, `secrets`,
  `runtime-providers`, `telemetry`, `client-sdk`, `test-utils`.
- `CLAUDE.md`/`AGENTS.md`, PR template, CODEOWNERS, `.editorconfig`, `.gitattributes`.
- CI workflow: install, typecheck, lint, unit test, build.
- `docs/` skeleton with architecture copied in.

## Step-by-step

### Step 1.1 — Initialise
```bash
mkdir qe-workspace && cd qe-workspace && git init -b main
echo "<node-lts-version>" > .nvmrc
```
`.npmrc`:
```ini
engine-strict=true
save-exact=true
fund=false
audit-level=high
```
`.gitattributes`: `* text=auto eol=lf` (important for Windows contributors and shell scripts).

### Step 1.2 — Root `package.json`
```json
{
  "name": "qe-workspace",
  "private": true,
  "engines": { "node": ">=<lts-major> <<next-major>" },
  "workspaces": ["packages/*", "extensions/*", "apps/*", "tests/*"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "typecheck": "tsc -b tsconfig.build.json",
    "lint": "eslint . --max-warnings=0",
    "format": "prettier --write .",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "clean": "git clean -xdf -e .env"
  },
  "devDependencies": {
    "typescript": "<pinned>", "eslint": "<pinned>", "typescript-eslint": "<pinned>",
    "eslint-plugin-boundaries": "<pinned>", "prettier": "<pinned>", "vitest": "<pinned>",
    "@vitest/coverage-v8": "<pinned>"
  }
}
```

### Step 1.3 — TypeScript base
`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true, "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true, "declaration": true, "sourceMap": true,
    "composite": true, "skipLibCheck": true, "esModuleInterop": true, "forceConsistentCasingInFileNames": true
  }
}
```
> Theia extensions are compiled with Theia's expected settings (often CommonJS + `experimentalDecorators`
> + `emitDecoratorMetadata` for InversifyJS). Give `extensions/*` their own `tsconfig` extending a
> `tsconfig.theia.json` rather than forcing NodeNext on them.

### Step 1.4 — Package template
Each package:
```text
packages/domain/
  package.json   {"name":"@qe/domain","version":"0.0.0","type":"module","main":"dist/index.js","types":"dist/index.d.ts",
                  "scripts":{"build":"tsc -b"}}
  tsconfig.json  {"extends":"../../tsconfig.base.json","compilerOptions":{"outDir":"dist","rootDir":"src"},"include":["src"]}
  src/index.ts
  src/__tests__/index.test.ts
```

### Step 1.5 — Seed `@qe/domain` with real primitives
```ts
// packages/domain/src/errors.ts
export const ErrorCodes = ['AUTH_REQUIRED','CSRF_REJECTED','FORBIDDEN','NOT_FOUND','INVALID_REQUEST','CONFLICT',
  'WORKSPACE_NOT_READY','QUOTA_EXCEEDED','RATE_LIMITED','TARGET_NOT_ALLOWED','TARGET_ADDRESS_FORBIDDEN',
  'HOST_KEY_UNKNOWN','HOST_KEY_MISMATCH','CREDENTIALS_UNAVAILABLE','CREDENTIALS_REJECTED','SSH_TIMEOUT',
  'SSH_UNREACHABLE','SESSION_EXPIRED','SESSION_REVOKED','PATH_OUTSIDE_ROOT','REMOTE_FILE_TOO_LARGE',
  'REMOTE_FILE_CONFLICT','INTERNAL_ERROR'] as const;
export type ErrorCode = typeof ErrorCodes[number];

export class DomainError extends Error {
  constructor(readonly code: ErrorCode, message?: string, readonly details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'DomainError';
  }
}
export function assertNever(x: never): never { throw new Error(`Unexpected: ${String(x)}`); }
```
```ts
// packages/domain/src/workspace-state.ts
export type WorkspaceState = 'CREATED'|'STARTING'|'RUNNING'|'STOPPING'|'STOPPED'|'FAILED'|'DELETING'|'DELETED';
const transitions: Record<WorkspaceState, readonly WorkspaceState[]> = {
  CREATED: ['STARTING','DELETING'], STARTING: ['RUNNING','FAILED','STOPPING'],
  RUNNING: ['STOPPING','FAILED'], STOPPING: ['STOPPED','FAILED'], STOPPED: ['STARTING','DELETING'],
  FAILED: ['STARTING','STOPPING','DELETING'], DELETING: ['DELETED'], DELETED: [],
};
export const canTransition = (from: WorkspaceState, to: WorkspaceState) => transitions[from].includes(to);
```
Add equivalent `session-state.ts`. Unit-test every legal and illegal transition.

### Step 1.6 — ESLint with boundaries
Configure `eslint.config.js` (flat config) with `typescript-eslint` strict-type-checked, rules:
`@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/no-floating-promises: error`,
`no-restricted-imports` for `child_process` outside `runtime-providers`/`broker-core`/runner backend,
and `boundaries/element-types` encoding the dependency rules.

### Step 1.7 — Vitest workspace
`vitest.config.ts` with projects `unit` (`**/src/**/*.test.ts`) and `integration`
(`**/*.int.test.ts`, longer timeouts). Coverage thresholds per package.

### Step 1.8 — Repo hygiene files
Copy from `06_TEMPLATES/`: `CLAUDE.md`, `AGENTS.md` (repo root), `PULL_REQUEST_TEMPLATE.md` (→ `.github/`),
CODEOWNERS block from `CODEOWNERS_AND_CONFIG_SNIPPETS.md` (→ `.github/CODEOWNERS`), `PHASE_GATE_TEMPLATE.md` and
`ADR_TEMPLATE.md` (→ `docs/`). Copy `01_ARCHITECTURE/*` → `docs/architecture/`, `02_PHASES/*` → `docs/phases/`,
`05_ADR/*` → `docs/adr/`. The prompt packs expect these paths.

### Step 1.9 — CI
Add `.github/workflows/ci.yml` (verify job from `12_CICD_AND_RELEASE.md`). Branch protection on `main`:
required checks, 1 review, no force-push.

### Step 1.10 — Developer bootstrap
`scripts/bootstrap.sh` + `scripts/bootstrap.ps1`: check Node version, Docker, run `npm ci`, build.
`README.md`: prerequisites, `npm ci`, `npm run build`, `npm run test:unit`.

## Tests
- Domain state machine tests (all transitions).
- A lint test proving a forbidden import fails (e.g. fixture in `tests/lint-fixtures`).

## Exit criteria
- [ ] Fresh clone → `npm ci && npm run typecheck && npm run lint && npm run test:unit && npm run build` passes on Linux **and** Windows.
- [ ] CI green; branch protection enabled.
- [ ] Boundaries rule demonstrably blocks a forbidden import.

## Pitfalls
- Mixing ESM/CJS carelessly — decide per package and document; Theia extensions are typically CJS.
- Letting Windows CRLF break shell scripts → `.gitattributes`.
