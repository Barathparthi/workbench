# AGENTS.md (for non-Claude coding agents — same rules as CLAUDE.md)

`CLAUDE.md` in the repository root is the single source of agent rules. If your tool reads only
`AGENTS.md`, this file mirrors it:

- Frontend never does process/FS/SSH/secrets/policy work.
- Runtimes get no platform secrets or lab egress.
- Hosted SSH only to registered targets after authz + policy + SSRF; host-key verification fails closed.
- Never handle/log raw credentials, tokens, tickets, terminal bytes, file contents.
- No shell interpolation; every route has a permission; privileged actions audited.
- Never weaken tests or security controls. Report real command output. Ask when unsure.

Where things are: architecture `01_ARCHITECTURE/`, phase guides `02_PHASES/`, ADRs `05_ADR/`, prompts
`03_PROMPTS/`, project state `docs/PROJECT_LOG.md`.

Commands: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:unit`,
`npm run test:integration`, `npm run build`, `npm run verify` (all of the CI checks); from Phase 02 also
`npm run test:e2e`, `npm run check:theia-versions` and `QE_VSX_URL=… npm run plugins:download` (ADR-012); from
Phase 03 the dev stack (`deploy/compose/docker-compose.dev.yml`) and `npm run dev -w @qe/control-plane`. Local machine
setup and requirements: `docs/LOCAL_DEVELOPMENT.md`.
