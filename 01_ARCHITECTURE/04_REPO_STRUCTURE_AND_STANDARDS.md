# 04 — Repository Structure and Engineering Standards

## 1. Monorepo layout

```text
qe-workspace/
├── apps/
│   ├── ide-browser/              # Theia app, target=browser (hosted + local web)
│   ├── ide-electron/             # Theia app, target=electron (desktop)
│   ├── control-plane/            # Fastify API + workspace router + reconciler
│   └── connection-broker/        # SSH broker service
│
├── extensions/                   # Theia extensions (shared by both IDE apps)
│   ├── qe-core/                  # branding, env detection, settings, commands
│   ├── qe-workspaces/            # workspace picker/lifecycle UI (hosted)
│   ├── qe-remote/                # remote connections view, remote terminal, qe-ssh:// FS provider
│   ├── qe-runner/                # test runner UI + backend contribution
│   └── qe-admin/                 # audit viewer, target admin (admin role)
│
├── packages/                     # pure TS libraries (no Theia, no Fastify unless named)
│   ├── domain/                   # entities, value objects, state machines, errors
│   ├── contracts/                # Zod schemas: REST DTOs, WS protocol, OpenAPI generation
│   ├── rbac/                     # permission matrix, evaluator
│   ├── policy/                   # target connection policy evaluation, SSRF rules
│   ├── runner/                   # QE runner model: run types, framework adapters (argv only), JUnit parsing (ADR-014)
│   ├── broker-core/              # SshTransport, host-key verifier, path confinement, session registry
│   ├── secrets/                  # SecretProvider interface + adapters (vault, file-dev)
│   ├── runtime-providers/        # WorkspaceRuntimeProvider: kubernetes, docker, local
│   ├── telemetry/                # OTel bootstrap, logger factory with redaction, metric names
│   ├── client-sdk/               # typed client for control plane & broker (used by extensions)
│   └── test-utils/               # fixtures, testcontainers helpers, fake IdP, ssh test server
│
├── images/
│   ├── workspace-runtime/        # Dockerfile for runtime image(s), toolchain layers
│   ├── control-plane/
│   └── connection-broker/
│
├── deploy/
│   ├── compose/                  # docker-compose.dev.yml, docker-compose.local-web.yml
│   ├── helm/qe-workspace/        # umbrella chart
│   └── policies/                 # Kyverno/Gatekeeper policies, NetworkPolicies
│
├── tests/
│   ├── e2e/                      # Playwright (browser + electron projects)
│   ├── integration/              # cross-service tests with testcontainers
│   ├── security/                 # authz matrix, SSRF, traversal, WS hijack, leak scans
│   ├── parity/                   # same scenarios against hosted/local-web/desktop
│   └── load/                     # k6 scripts
│
├── docs/
│   ├── architecture/  adr/  runbooks/  phase-gates/  user/  admin/
│   └── ORG_DECISIONS.md
│
├── scripts/                      # dev bootstrap, seed data, release helpers
├── .github/workflows/            # CI/CD
├── CLAUDE.md / AGENTS.md         # agent rules (from 06_TEMPLATES)
├── package.json                  # npm workspaces root
├── tsconfig.base.json
├── .nvmrc  .npmrc  .editorconfig  .gitattributes
└── README.md
```

### Dependency rules (enforced with `eslint-plugin-boundaries` or `dependency-cruiser`)

```text
domain        ← depends on nothing
contracts     ← domain
rbac, policy  ← domain, contracts
runner        ← domain   (ADR-014)
broker-core   ← domain, contracts, policy, runner, secrets, telemetry
secrets       ← domain, telemetry
runtime-providers ← domain, telemetry
client-sdk    ← contracts
extensions/*  ← client-sdk, contracts, domain, runner   (NEVER secrets, broker-core server parts, runtime-providers)
apps/control-plane     ← domain, contracts, rbac, policy, secrets, runtime-providers, telemetry
apps/connection-broker ← broker-core, contracts, policy, secrets, telemetry
apps/ide-*    ← extensions/*
```
Exception: `extensions/qe-remote` **electron backend module** may import `broker-core` (embedded broker).
This exception is listed explicitly in the boundary config.

## 2. TypeScript standards

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`,
  `noImplicitOverride: true`, `useUnknownInCatchVariables: true`.
- No `any` (lint error). `unknown` + Zod parsing at boundaries.
- Discriminated unions for states/messages; exhaustive `switch` with `assertNever`.
- Errors: `class DomainError extends Error { code: ErrorCode; httpStatus; details? }` — never throw strings.
- Async: every network call has a timeout (`AbortSignal.timeout(ms)`); no floating promises (lint rule).
- No `child_process.exec` with string commands. Use `spawn(file, args, { shell: false })`.
- No `eval`, `new Function`, dynamic `require` of user input.

## 3. API standards

- Base path `/api/v1`. Breaking change → `/api/v2`.
- Request/response schemas in `packages/contracts`; OpenAPI generated in CI and diffed
  (breaking-change check with `oasdiff`).
- Errors: `application/problem+json` (RFC 9457) with `code`, `title`, `status`, `requestId`.
- Pagination: cursor-based (`?cursor=…&limit=…`, max 200).
- Idempotency: lifecycle POSTs are idempotent by state; creation endpoints accept `Idempotency-Key`.
- Every route declares: `permission`, `rateLimit`, `audit` (on/off), `bodyLimit`.

## 4. Database standards

- Migrations are forward-only SQL files, reviewed like code, numbered `0001_…sql`.
- **Expand → migrate → contract** for breaking schema changes (enables rollback one version).
- FK + indexes declared deliberately; every query on hot paths has an index.
- No secrets in tables; credential tables store **references** only.
- `audit_events` is insert-only for the app role (no UPDATE/DELETE grant).

## 5. Logging standards

- pino JSON; fields: `time, level, msg, service, version, env, requestId, traceId, spanId, userId, workspaceId, sessionId, targetId`.
- Redact paths: `req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.privateKey`,
  `*.passphrase`, `*.token`, `*.ticket`, `*.secret`, `env`.
- Never log terminal input/output bytes, file contents, or command lines from users.
- Levels: `error` (needs action), `warn` (degraded), `info` (lifecycle), `debug` (off in prod).

## 6. Git & review standards

- Trunk-based: `main` always releasable; short-lived branches `phase-xx-*`, `feat/*`, `fix/*`.
- Conventional Commits (`feat(broker): verify host key with SHA256 fingerprint`).
- PR template (06_TEMPLATES) required; CODEOWNERS for `packages/broker-core`, `packages/policy`,
  `packages/secrets`, `deploy/` → security + platform reviewers.
- Squash merge; signed commits if org requires.

## 7. Required CI checks on every PR

1. `npm ci` (lockfile integrity) + engines check
2. `npm run typecheck`
3. `npm run lint` (incl. boundaries)
4. `npm run test:unit` (coverage gate: domain/policy/broker-core ≥ 90% lines, others ≥ 75%)
5. `npm run test:integration` (testcontainers)
6. `npm run build` (all apps)
7. OpenAPI diff (no unapproved breaking change)
8. Dependency scan, secret scan, SAST
9. Docker build + image scan for changed images
10. Helm lint + kubeconform + policy checks for changed `deploy/`

## 8. Definition of Ready (story) / Definition of Done (feature)

**Ready**: acceptance criteria, permission(s) named, audit events named, metrics named, test cases listed.

**Done**: code, unit + negative tests, integration test where a boundary is crossed, authz enforced
server-side, telemetry + audit emitted, docs updated, CI green, demo evidence recorded.
