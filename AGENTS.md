# AGENTS.md — rules for every coding agent (Codex, OpenCode, Codebuff/Freebuff, Cursor, …)

Claude Code reads `CLAUDE.md`; other agents read this file. **Both carry the same rules.** If they ever differ,
`CLAUDE.md` wins; fix this file to match.

## Read first, every session

1. `CLAUDE.md` — the full rules, commands and monorepo conventions.
2. `docs/PROJECT_LOG.md` — which phase is current, what is open, next actions.
3. `docs/CONTINUING_WITH_AI_AGENTS.md` — the working environment (Windows + WSL), the remaining phases in order, the
   workflow, and the lessons learned so far.
4. The current phase's guide in `02_PHASES/` and prompt pack in `03_PROMPTS/`.

## Non-negotiable rules

1. Browser/frontend code never does process, filesystem, SSH, secret or policy work.
2. Workspace runtimes are user-controlled: no platform secrets, no Vault, no lab egress.
3. Hosted SSH only to registered targets: authz + policy + SSRF check BEFORE any connect; connect to the validated IP;
   host-key verification fails closed.
4. Never accept/return/log raw SSH keys, passwords, tokens, cookies, tickets; never log terminal bytes, file contents
   or command lines.
5. Forwarding (port/agent/X11) off unless policy enables it.
6. `spawn(file, args, { shell: false })` only; remote exec via the single quoting helper (`shellQuote`).
7. Every route declares `config.permission`; invisible resources return 404; privileged actions emit an audit event.
8. Never delete/skip/weaken tests or security checks to get green.

## Working style

- Inspect and plan prompts mean **no edits**. The owner approves a plan before implementation.
- Keep to the current phase; small commits, one per step, Conventional Commits.
- **Commit and PR messages are plain: no `Co-Authored-By`, "Generated with" or other attribution lines.**
- Report ACTUAL command output, never expected output.
- Missing org decision or uncertain API: stop and ask. Never run `npm audit fix --force`.
- A new or changed package dependency between workspace packages (`eslint.config.js` `allowedDependencies`) needs an
  ADR; new third-party dependencies are pinned exactly and listed in the plan for approval.
- After meaningful work: an entry in `docs/PROJECT_LOG.md` and `CHANGELOG.md`; at the end of a phase a gate record in
  `docs/phase-gates/PHASE_xx.md` (template `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`).
- The owner runs `sudo` commands, pushes to `main` and merges PRs. Never ask for tokens or passwords.

## Code style

TypeScript strict, no `any`, Zod at boundaries, `DomainError(code)`, discriminated unions + `assertNever`, timeouts on
all I/O, explicit cleanup for PTYs/channels/sockets/timers, package boundaries enforced by lint. Library packages in
`packages/*` are ESM and export `"@qe/source": "./src/index.ts"`; a workspace dependency must appear in the import,
`dependencies` and `tsconfig.json` `references`. Unit tests sit next to the code (`src/**/__tests__/*.test.ts`);
integration tests are `*.int.test.ts`.

## Commands

`npm ci` (Node 24.22.0 from `.nvmrc`), `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run test:unit`, `npm run test:integration` (Docker), `npm run build`, `npm run verify` (everything CI's required
check runs), `npm run test:e2e` / `npx playwright test --project=<name>`, `npm run check:theia-versions`,
`QE_VSX_URL=… npm run plugins:download` (ADR-012). Dev stack:
`docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait`, `npm run dev -w @qe/connection-broker`,
`npm run dev -w @qe/control-plane`. Setup for people: `docs/GETTING_STARTED.md`; for developers:
`docs/LOCAL_DEVELOPMENT.md`.

Where things are: architecture `01_ARCHITECTURE/`, phase guides `02_PHASES/`, prompts `03_PROMPTS/`, operations
`04_OPERATIONS/`, ADRs `05_ADR/`, templates `06_TEMPLATES/`, project records `docs/`.
