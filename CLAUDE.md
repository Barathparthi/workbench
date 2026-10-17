# CLAUDE.md — QE Workspace repository rules

Adapted from `06_TEMPLATES/CLAUDE.md`. `AGENTS.md` mirrors these rules for other coding agents.

## What this repo is

QE Workspace: Theia-based IDE for browser (hosted/local web) and desktop (Electron), with a control plane
(Fastify + PostgreSQL), an SSH connection broker (ssh2), per-workspace runtimes (K8s/Docker), and a QE
test runner.

This repository holds **both** the implementation kit and the product code:

| Kit folder (source of truth) | Prompts call it      | Contents                                         |
| ---------------------------- | -------------------- | ------------------------------------------------ |
| `01_ARCHITECTURE/`           | `docs/architecture/` | Requirements, architecture, contracts, standards |
| `02_PHASES/`                 | `docs/phases/`       | Phase guides 00–19                               |
| `05_ADR/`                    | `docs/adr/`          | Architecture decision records                    |
| `03_PROMPTS/`                | —                    | Session bootstrap, 8-step loop, phase packs      |
| `06_TEMPLATES/`              | —                    | Phase gate, ADR and PR templates                 |

The kit is not copied into `docs/` (no duplicate to drift). `docs/` holds product-specific records:
`docs/PROJECT_LOG.md` (what was done, when, and why), `docs/ORG_DECISIONS.md`, `docs/phase-gates/`.

**Current state:** read `docs/PROJECT_LOG.md` first — it says which phase is in progress and what is open.

## Commands

- Install: `npm ci` (Node version in `.nvmrc`; `engine-strict` is on)
- Typecheck: `npm run typecheck` · Lint: `npm run lint` · Format check: `npm run format:check`
- Unit: `npm run test:unit` · Integration (Docker needed, from Phase 03): `npm run test:integration`
- Build all: `npm run build` · Everything CI runs: `npm run verify`
- From Phase 02: Browser IDE `npm run start -w @qe/ide-browser` · E2E smoke `npm run test:e2e` · Theia version guard
  `npm run check:theia-versions` · Plugins `QE_VSX_URL=… npm run plugins:download` (pinned in `config/vscode-plugins.json`;
  never `theia download:plugins`, never `@theia/vsx-registry` — ADR-012)
- From Phase 03: dev stack `docker compose -f deploy/compose/docker-compose.dev.yml up -d`

## Non-negotiable rules

1. Browser/frontend code never does process, filesystem, SSH, secret or policy work.
2. Workspace runtimes are user-controlled: no platform secrets, no Vault, no lab egress.
3. Hosted SSH only to registered targets: authz + policy + SSRF check BEFORE any connect; connect to the validated IP; host-key verification fails closed.
4. Never accept/return/log raw SSH keys, passwords, tokens, cookies, tickets; never log terminal bytes, file contents or command lines.
5. Forwarding (port/agent/X11) off unless policy enables it.
6. `spawn(file, args, { shell: false })` only; remote exec via the single quoting helper.
7. Every route declares `config.permission`; invisible resources return 404; privileged actions emit an audit event.
8. Never delete/skip/weaken tests or security checks to get green.

## Code style

TypeScript strict, no `any`, Zod at boundaries, `DomainError(code)`, discriminated unions + `assertNever`,
timeouts on all I/O, explicit cleanup for PTYs/channels/sockets/timers, package boundaries enforced by lint.

## Monorepo conventions

- Library packages live in `packages/*`, are ESM (`"type": "module"`), and are built with `tsc -b`.
- Each package exports `"@qe/source": "./src/index.ts"` first. TypeScript (`customConditions`), Vitest and
  the ESLint resolver use that condition, so tests and lint always see sources; Node at runtime uses `dist`.
- A workspace dependency must appear in three places: the import, the package's `dependencies`, and its
  `tsconfig.json` `references`. `tests/lint/workspace-graph.test.ts` fails if they disagree.
- Allowed package dependencies are encoded in `eslint.config.js` (`allowedDependencies`) from
  `01_ARCHITECTURE/04_REPO_STRUCTURE_AND_STANDARDS.md` §1. Changing them needs an ADR.
- Unit tests sit next to the code in `src/**/__tests__/*.test.ts`; integration tests are `*.int.test.ts`.

## Working style

- Read before writing; keep changes to the current phase; small commits (Conventional Commits).
- Inspect/plan prompts mean no edits. Report ACTUAL command output.
- Missing org decision or uncertain API: stop and ask.
- After meaningful work, add an entry to `docs/PROJECT_LOG.md` and `CHANGELOG.md`.
