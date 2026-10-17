# Phase 03 — Control Plane and Database

| | |
|---|---|
| **Goal** | A versioned, validated, observable API service on PostgreSQL with migrations |
| **Duration** | 1 week |
| **Prerequisites** | Phase 01 |
| **Prompt pack** | `03_PROMPTS/PHASE_03_PROMPTS.md` |

## Deliverables
- `apps/control-plane` (Fastify): config validation, `/healthz` `/readyz` `/version`, problem+json error handler, request IDs, redacting logger, graceful shutdown.
- `packages/contracts`: Zod schemas for v1 DTOs + OpenAPI generation.
- Migrations `0001_init.sql` (from `01_ARCHITECTURE/06_DATA_MODEL.md`) + runner script.
- Kysely repositories: users, workspaces, members, templates, audit (insert-only).
- `deploy/compose/docker-compose.dev.yml` with PostgreSQL.
- Integration tests with Testcontainers.

## Step-by-step

### 3.1 Config (fail fast)
```ts
import { z } from 'zod';
const Config = z.object({
  NODE_ENV: z.enum(['development','test','production']),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().url(),
  PUBLIC_ORIGIN: z.string().url(),
  ALLOWED_ORIGINS: z.string().transform(s => s.split(',')),
  AUTH_MODE: z.enum(['oidc','dev']),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug']).default('info'),
  SHUTDOWN_GRACE_MS: z.coerce.number().default(30000),
}).superRefine((c, ctx) => {
  if (c.NODE_ENV === 'production' && c.AUTH_MODE === 'dev')
    ctx.addIssue({ code: 'custom', message: 'AUTH_MODE=dev is forbidden in production' });
});
export const loadConfig = (env = process.env) => Config.parse(env);
```

### 3.2 Server bootstrap
- `buildServer(config, deps)` returns a Fastify instance (testable with `app.inject`, no listening).
- Plugins: `@fastify/helmet`, `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/sensible`, `fastify-type-provider-zod`.
- `genReqId`: accept `x-request-id` matching `^[A-Za-z0-9-]{8,64}$`, else `randomUUID()`; echo it.
- pino `redact`: `req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.privateKey`, `*.token`, `*.ticket`, `*.secret`.
- `bodyLimit: 1 MiB`.
- Error handler: `DomainError` → problem+json with mapped status; Zod → `INVALID_REQUEST` + issues; unknown → `INTERNAL_ERROR` (full error logged server-side only).

### 3.3 Route declaration pattern
```ts
app.route({
  method: 'GET', url: '/api/v1/workspaces',
  schema: { querystring: ListWorkspacesQuery, response: { 200: WorkspaceList } },
  config: { permission: 'workspace:read', audit: false, rateLimit: { max: 120, timeWindow: '1 minute' } },
  handler: async (req) => workspaces.listForUser(req.principal, req.query),
});
```
Every route declares permission, audit and rate limit (enforced in Phase 04).

### 3.4 Health
`/healthz` → 200 if process alive. `/readyz` → `SELECT 1` < 1 s **and** migrations at expected version, else 503. `/version` → `{version, commit, builtAt}`.

### 3.5 Database layer
- `pg` Pool: `statement_timeout=5s`, `idle_in_transaction_session_timeout=10s`.
- Kysely + `kysely-codegen` types. SQL only inside `src/repos/`.
- Workspace state compare-and-set:
```ts
async transition(id: string, from: WorkspaceState, to: WorkspaceState, reason?: string) {
  if (!canTransition(from, to)) throw new DomainError('CONFLICT', `illegal ${from}->${to}`);
  return (await db.updateTable('workspaces')
    .set({ state: to, state_reason: reason ?? null, state_version: sql`state_version + 1`, updated_at: sql`now()` })
    .where('id', '=', id).where('state', '=', from)
    .returningAll().executeTakeFirst()) ?? null;   // null => lost race; caller re-reads (idempotent)
}
```

### 3.6 Audit writer
- Validate metadata against the per-action allowlist (`packages/contracts/audit.ts`).
- `hash = sha256(prev_hash || canonical_json(event))` under a PG advisory lock.
- If an audit write fails for a privileged action, the action fails (fail closed).

### 3.7 Workspace metadata CRUD
`POST/GET/PATCH/DELETE /api/v1/workspaces`, `GET /api/v1/workspace-templates`. Lifecycle endpoints return 501 until Phase 05. Seed templates in `0002_seed_templates.sql`.

### 3.8 OpenAPI
`npm run openapi:generate` → `openapi.json`; CI runs `oasdiff breaking` against `main`.

### 3.9 Graceful shutdown
SIGTERM → `/readyz` 503 → stop accepting → `app.close()` within grace → close pool → exit.

### 3.10 Compose
```yaml
services:
  postgres:
    image: postgres:<pinned>
    environment: { POSTGRES_DB: qews, POSTGRES_USER: qews, POSTGRES_PASSWORD: devonly }
    ports: ["127.0.0.1:5432:5432"]
    healthcheck: { test: ["CMD-SHELL","pg_isready -U qews"], interval: 5s }
```

## Tests
- Unit: config (prod + dev rejected), error mapping, request-ID validation, redaction canary.
- Integration (Testcontainers PG): migrations from empty; CRUD; 20 concurrent CAS → exactly 1 winner; audit hash chain verifies; app role cannot UPDATE/DELETE `audit_events`.
- Contract: generated OpenAPI is valid.

## Exit criteria
- [ ] `docker compose up postgres` + `npm run dev -w @qe/control-plane` → `/readyz` 200.
- [ ] Integration suite green in CI; no stack traces in responses; redaction test passes.
