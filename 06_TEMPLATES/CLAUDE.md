# CLAUDE.md — QE Workspace repository rules (copy to repo root)

## What this repo is
QE Workspace: Theia-based IDE for browser (hosted/local web) and desktop (Electron), with a control plane
(Fastify + PostgreSQL), an SSH connection broker (ssh2), per-workspace runtimes (K8s/Docker), and a QE
test runner. Architecture: `docs/architecture/`. Decisions: `docs/adr/`. Phase guides: `docs/phases/`.

## Commands
- Install: `npm ci` · Typecheck: `npm run typecheck` · Lint: `npm run lint`
- Unit: `npm run test:unit` · Integration (Docker needed): `npm run test:integration`
- Build all: `npm run build` · Browser IDE: `npm run start -w @qe/ide-browser`
- Dev stack: `docker compose -f deploy/compose/docker-compose.dev.yml up -d`

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

## Working style
- Read before writing; keep changes to the current phase; small commits (Conventional Commits).
- Inspect/plan prompts mean no edits. Report ACTUAL command output.
- Missing org decision or uncertain API: stop and ask.
