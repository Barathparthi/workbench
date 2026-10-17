# 05 — API, WebSocket and Error Contracts

All schemas live in `packages/contracts` as **Zod** schemas; TypeScript types and OpenAPI are generated
from them. The tables below are the contract of record for v1.

## 1. Conventions

| Item | Rule |
|---|---|
| Base | `https://{host}/api/v1` |
| Auth (browser) | `qews_session` cookie (HttpOnly, Secure, SameSite=Lax, path=/) + CSRF header for unsafe methods |
| Auth (desktop/service) | `Authorization: Bearer <access token>` (OIDC access token or service JWT) |
| CSRF | Double-submit: `qews_csrf` cookie (not HttpOnly) echoed in `x-csrf-token`; Origin must match allowlist |
| Content type | `application/json; charset=utf-8` |
| Request ID | `x-request-id` accepted (validated `^[A-Za-z0-9-]{8,64}$`) or generated; echoed |
| Trace | W3C `traceparent` accepted/propagated |
| Errors | `application/problem+json` |
| Time | RFC 3339 UTC |

## 2. REST endpoints (v1)

### 2.1 Auth & me
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/auth/login?returnTo=` | public | Starts OIDC code+PKCE; `returnTo` must be same-origin relative path |
| GET | `/auth/callback` | public | Validates state/nonce, creates session |
| POST | `/auth/logout` | authenticated | Revokes session, optional IdP logout |
| GET | `/api/v1/me` | authenticated | `{ id, displayName, email, roles, permissions[] }` |

### 2.2 Workspaces
| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/workspaces` | `workspace:read` (filtered by membership) |
| POST | `/api/v1/workspaces` | `workspace:create` |
| GET | `/api/v1/workspaces/{id}` | `workspace:read` on id |
| PATCH | `/api/v1/workspaces/{id}` | `workspace:write` on id |
| DELETE | `/api/v1/workspaces/{id}` | `workspace:delete` on id |
| POST | `/api/v1/workspaces/{id}/start` | `workspace:start` |
| POST | `/api/v1/workspaces/{id}/stop` | `workspace:stop` |
| GET | `/api/v1/workspaces/{id}/events` | `workspace:read` (SSE status stream) |
| GET/PUT/DELETE | `/api/v1/workspaces/{id}/members[/{userId}]` | `workspace:admin` |
| GET | `/api/v1/workspace-templates` | `workspace:create` |

Create request:
```json
{ "name": "login-automation", "templateId": "tpl_python_pytest",
  "git": { "url": "https://git.corp/qe/login-automation.git", "ref": "main" },
  "resources": { "profile": "standard" } }
```
Workspace response:
```json
{ "id": "0192…", "name": "login-automation", "state": "RUNNING",
  "templateId": "tpl_python_pytest", "ownerId": "…", "ideUrl": "/w/0192…/",
  "resources": { "profile": "standard", "cpu": "2", "memory": "4Gi", "disk": "20Gi" },
  "lastActiveAt": "2026-10-02T10:15:00Z", "createdAt": "…", "updatedAt": "…" }
```

### 2.3 Remote targets (admin registers, users list)
| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/targets` | `target:list` (filtered by policy → only connectable targets) |
| POST | `/api/v1/targets` | `target:admin` |
| GET | `/api/v1/targets/{id}` | `target:list` + visible |
| PATCH | `/api/v1/targets/{id}` | `target:admin` |
| DELETE | `/api/v1/targets/{id}` | `target:admin` |
| POST | `/api/v1/targets/{id}/host-keys:scan` | `target:admin` (returns presented key fingerprints for **approval**, never auto-trusts) |
| POST | `/api/v1/targets/{id}/host-keys` | `target:admin` (approve fingerprint) |
| POST | `/api/v1/targets/{id}/test-connection` | `target:admin` |
| GET/POST/PATCH | `/api/v1/policies[/{id}]` | `policy:admin` |

Register target request:
```json
{ "name": "qe-linux-01", "description": "Ubuntu lab VM, rack 3",
  "host": "qe-linux-01.lab.corp", "port": 22, "os": "linux",
  "auth": { "method": "ssh_certificate", "principalTemplate": "{{user.username}}" },
  "remoteRoot": "/home/{{principal}}/projects",
  "policyId": "pol_lab_a", "tags": ["lab-a", "ubuntu"],
  "jumpHostId": null }
```
`auth.method` ∈ `ssh_certificate | vault_key | vault_password`. Raw keys/passwords are **never** accepted
on this endpoint; credentials are written to the secret manager by an admin workflow and referenced.

### 2.4 Sessions (remote terminal / files / exec)
| Method | Path | Permission |
|---|---|---|
| POST | `/api/v1/targets/{id}/sessions` | `remote:connect` + kind capability |
| GET | `/api/v1/sessions?mine=true` | authenticated |
| GET | `/api/v1/sessions/{id}` | owner or `session:admin` |
| DELETE | `/api/v1/sessions/{id}` | owner or `session:admin` |
| POST | `/api/v1/users/{userId}/sessions:revoke` | `session:admin` |
| WS | `/api/v1/sessions/{id}/stream` | ticket (terminal kind) |
| POST | `/api/v1/sessions/{id}/fs/{op}` | ticket-less, cookie/bearer + session ownership (files kind) |

Open session:
```json
POST /api/v1/targets/tg_123/sessions
{ "kind": "terminal", "workspaceId": "ws_456", "terminal": { "cols": 120, "rows": 32 } }

201 Created
{ "sessionId": "ss_789", "kind": "terminal", "state": "AUTHORIZED",
  "streamUrl": "/api/v1/sessions/ss_789/stream", "ticket": "<opaque, 60s, single-use>",
  "expiresAt": "2026-10-02T18:15:00Z", "idleTimeoutSec": 1800 }
```
`kind` ∈ `terminal | files | exec`.

File ops (`kind: files`), all paths **relative to remoteRoot**, POSIX style:
| op | Body | Result |
|---|---|---|
| `stat` | `{ path }` | `{ type, size, mtimeMs, mode, etag }` |
| `list` | `{ path, limit? }` | `{ entries: [{ name, type, size, mtimeMs }], truncated }` |
| `read` | `{ path, maxBytes? }` | `{ contentBase64, etag }` (≤ 10 MB default) |
| `write` | `{ path, contentBase64, ifMatch?, create?, overwrite? }` | `{ etag }` or 409 `REMOTE_FILE_CONFLICT` |
| `mkdir` | `{ path, recursive? }` | `{}` |
| `rename` | `{ from, to, overwrite? }` | `{}` |
| `delete` | `{ path, recursive? }` | `{}` |

### 2.5 QE runner
| Method | Path | Permission |
|---|---|---|
| POST | `/api/v1/workspaces/{id}/test-runs` | `qe_test:execute` (records a run executed in runtime) |
| POST | `/api/v1/targets/{id}/test-runs` | `qe_test:execute` + `remote:execute` |
| GET | `/api/v1/test-runs?workspaceId=` | `workspace:read` |
| GET | `/api/v1/test-runs/{id}` | `workspace:read` |
| POST | `/api/v1/test-runs/{id}/cancel` | `qe_test:cancel` |
| GET | `/api/v1/test-runs/{id}/artifacts/{artifactId}` | `workspace:read` (signed short-lived URL) |

### 2.6 Audit & admin
| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/audit/events?actor=&action=&resourceType=&resourceId=&from=&to=&cursor=` | `audit:read` |
| GET | `/api/v1/audit/events:export?format=csv&…` | `audit:export` |
| GET | `/api/v1/admin/runtimes` | `platform:admin` |

### 2.7 Health
`GET /healthz` (liveness, no deps) · `GET /readyz` (deps OK) · `GET /version` (`{version, commit, builtAt}`)

## 3. Error model

```json
{ "type": "https://qe-workspace.corp/errors/TARGET_NOT_ALLOWED",
  "title": "You are not allowed to connect to this target",
  "status": 403, "code": "TARGET_NOT_ALLOWED", "requestId": "b5c1…", "details": {} }
```

| Code | HTTP | Meaning |
|---|---|---|
| `AUTH_REQUIRED` | 401 | No/invalid session |
| `CSRF_REJECTED` | 403 | CSRF/origin check failed |
| `FORBIDDEN` | 403 | Permission missing |
| `NOT_FOUND` | 404 | Resource absent **or not visible** (avoid enumeration) |
| `INVALID_REQUEST` | 400 | Schema validation failed (`details.issues`) |
| `CONFLICT` | 409 | State conflict |
| `WORKSPACE_NOT_READY` | 409 | Runtime not RUNNING |
| `QUOTA_EXCEEDED` | 429/409 | Workspace/session quota |
| `RATE_LIMITED` | 429 | With `Retry-After` |
| `TARGET_NOT_ALLOWED` | 403 | Policy denied |
| `TARGET_ADDRESS_FORBIDDEN` | 403 | SSRF guard denied resolved IP |
| `HOST_KEY_UNKNOWN` | 502 | No trusted key on record |
| `HOST_KEY_MISMATCH` | 502 | Presented key ≠ trusted (security event) |
| `CREDENTIALS_UNAVAILABLE` | 503 | Secret manager failed |
| `CREDENTIALS_REJECTED` | 502 | Target refused auth |
| `SSH_TIMEOUT` | 504 | Connect/handshake timeout |
| `SSH_UNREACHABLE` | 502 | TCP failure |
| `SESSION_EXPIRED` | 410 | Idle/absolute timeout |
| `SESSION_REVOKED` | 410 | Admin revocation |
| `PATH_OUTSIDE_ROOT` | 403 | Traversal/symlink escape |
| `REMOTE_FILE_TOO_LARGE` | 413 | Over limit |
| `REMOTE_FILE_CONFLICT` | 409 | ETag mismatch |
| `INTERNAL_ERROR` | 500 | No stack trace in body |

## 4. Remote terminal WebSocket protocol (`qews.v1`)

### 4.1 Handshake
- URL: `wss://{host}/api/v1/sessions/{sessionId}/stream`
- Subprotocols: `qews.v1`, `ticket.<base64url-ticket>` (ticket in subprotocol, **not** in query string, to keep it out of access logs).
- Server checks: Origin ∈ allowlist; ticket valid, unexpired, unused, bound to `sessionId` and user;
  session state AUTHORIZED; selects `qews.v1`.
- Max message 64 KiB; server ping every 20 s; client must pong within 10 s.

### 4.2 Frames
Control messages are JSON text frames; terminal data uses **binary frames** with a 1-byte type prefix
(avoids base64 overhead).

```ts
// Client → server (JSON)
type ClientMsg =
  | { t: "resize"; cols: number; rows: number }          // 1..1000 x 1..500
  | { t: "signal"; signal: "SIGINT" | "SIGTERM" | "SIGQUIT" }
  | { t: "close" }
  | { t: "ack"; bytes: number };                         // flow control
// Client → server (binary): 0x00 + UTF-8 input bytes (≤ 16 KiB per frame)

// Server → client (JSON)
type ServerMsg =
  | { t: "status"; state: "CONNECTING" | "ACTIVE" | "CLOSING" | "CLOSED"; reason?: string }
  | { t: "hostkey"; algorithm: string; fingerprintSha256: string; verified: true }
  | { t: "exit"; code: number | null; signal: string | null }
  | { t: "error"; code: ErrorCode; message: string };
// Server → client (binary): 0x01 + output bytes (≤ 32 KiB per frame), sequence implicit by order
```

### 4.3 Flow control / backpressure
- Server tracks unacknowledged bytes; pauses the SSH channel stream when > 1 MiB unacked; resumes when
  client `ack`s. Prevents `cat bigfile` from exhausting broker memory.

### 4.4 Close codes
| Code | Meaning |
|---|---|
| 1000 | Normal close |
| 4001 | Auth/ticket invalid |
| 4003 | Forbidden / policy changed |
| 4008 | Protocol violation (bad frame, too large) |
| 4010 | Session expired (idle/absolute) |
| 4011 | Session revoked |
| 4013 | Broker shutting down — reconnect allowed |
| 4500 | Internal error |

## 5. Internal control-plane ↔ broker API (mTLS, cluster-internal)

| Method | Path | Purpose |
|---|---|---|
| POST | `/internal/v1/tickets:redeem` | Broker redeems ticket → `{ sessionId, userId, targetSnapshot, policySnapshot, capabilities }` (single use) |
| POST | `/internal/v1/sessions/{id}/state` | Broker reports transitions (CONNECTING, ACTIVE, FAILED, CLOSED + reason) |
| POST | `/internal/v1/audit` | Broker submits audit events (or writes to a shared audit queue) |
| POST | `/internal/v1/sessions/{id}:close` | Control plane instructs close/revoke (broker endpoint) |

Service-to-service auth: mTLS (mesh or cert-manager-issued) **plus** a short-lived service JWT
(audience-scoped). NetworkPolicy restricts who can reach `/internal/*`.

## 6. Theia frontend ↔ backend

Standard Theia RPC over its WebSocket channel at `/w/{workspaceId}/services` (path depends on base path
configuration). Our backend contributions expose typed service interfaces declared in
`extensions/*/src/common/*-protocol.ts`, e.g.:

```ts
export const QeRunnerServicePath = '/services/qe-runner';
export const QeRunnerService = Symbol('QeRunnerService');
export interface QeRunnerService {
  discover(root: string): Promise<TestSuiteSummary[]>;
  start(request: StartRunRequest): Promise<{ runId: string }>;
  cancel(runId: string): Promise<void>;
  setClient(client: QeRunnerClient | undefined): void;   // server → client push (output, status)
}
```
