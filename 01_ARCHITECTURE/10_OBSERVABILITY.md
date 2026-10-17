# 10 — Observability Standard

## 1. Principles
- OpenTelemetry SDK in every Node service and in the Theia backend; OTLP → org collector.
- **Audit ≠ logs.** Audit answers *who did what to which privileged resource* (DB, tamper-evident).
  Logs answer *what the software did*. Metrics answer *how much/how fast*. Traces answer *where time went*.
- Privacy: no source code, file contents, terminal bytes, command lines, tokens, keys, cookies in any signal.

## 2. Resource attributes (all signals)
`service.name` (`qews-control-plane`, `qews-broker`, `qews-runtime`, `qews-desktop`), `service.version`,
`deployment.environment` (`dev|staging|prod`), `k8s.pod.name`, `k8s.namespace.name`.

## 3. Trace design

```text
HTTP POST /api/v1/targets/{id}/sessions            (control-plane, SERVER)
 ├─ authz.evaluate                                  attrs: permission, decision
 ├─ policy.evaluate                                 attrs: policy.id, policy.version, decision
 ├─ db.insert sessions
 └─ ticket.mint
WS /api/v1/sessions/{id}/stream                     (broker, SERVER) — linked via session.id
 ├─ ticket.redeem                                   (CLIENT → control-plane)
 ├─ ssrf.check                                      attrs: addresses.count, decision
 ├─ credentials.resolve                             attrs: method, provider (never material)
 ├─ ssh.connect                                     attrs: net.peer.port, ssh.kex, duration
 │   └─ ssh.hostkey.verify                          attrs: algorithm, result
 └─ ssh.channel.open                                attrs: channel.kind
```
- Long-lived WS sessions: do **not** keep one span open for hours. Emit a span for setup and span events
  / separate short spans for lifecycle transitions; link them by `session.id`.
- Propagate `traceparent` from the frontend for REST calls (browser OTel optional, behind privacy review).

### Allowed span/log attributes
`request.id, user.id (internal UUID), workspace.id, session.id, target.id, policy.id, error.code,
result, http.route, http.status_code, duration_ms, bytes_in, bytes_out`.

## 4. Metrics (names follow OTel semantic conventions where they exist)

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `http.server.request.duration` | histogram | route, method, status | API latency/SLO |
| `qews.authz.decisions` | counter | permission, decision | Denial spikes |
| `qews.workspaces.active` | gauge | template, profile | Capacity |
| `qews.workspace.start.duration` | histogram | template, cold/warm, result | Start SLO |
| `qews.workspace.transitions` | counter | from, to, reason | Lifecycle health |
| `qews.terminals.active` | gauge | mode (local/remote) | Load |
| `qews.terminal.open.duration` | histogram | mode, result | SLO |
| `qews.ws.disconnects` | counter | close_code | Connectivity issues |
| `qews.ssh.connect.duration` | histogram | result, auth_method | SLO |
| `qews.ssh.connections.active` | gauge | broker_instance | Capacity |
| `qews.ssh.failures` | counter | error_code (TIMEOUT, AUTH, HOSTKEY_MISMATCH, UNREACHABLE…) | Alerting |
| `qews.ssrf.blocked` | counter | reason | Security |
| `qews.remote_fs.op.duration` | histogram | op, result | Remote edit SLO |
| `qews.remote_fs.bytes` | counter | direction | Usage |
| `qews.test_runs.active` | gauge | framework | Load |
| `qews.test_run.duration` | histogram | framework, result | QE insight |
| `qews.credentials.issue.duration` | histogram | method, result | Vault health |
| `qews.audit.write.failures` | counter | — | Must be 0 |
| `qews.sessions.revoked` | counter | reason | Security |
| runtime CPU/memory/pids | from kubelet/cAdvisor | pod | Saturation |

Label cardinality rule: **no** user IDs, session IDs, target hostnames, or paths as metric labels.

## 5. Logs
- pino JSON to stdout; collector ships to log backend.
- Each log line includes `trace_id`/`span_id` when inside a span.
- Redaction tested by a unit test that logs a canary object containing every forbidden field.

## 6. Dashboards (as code — Grafana JSON / vendor equivalent in `deploy/observability/`)
1. **Platform health** — RPS, error rate, p95 latency per route, pod restarts, DB pool.
2. **Workspaces** — active, starting, failed starts, start p95, idle stops, node capacity.
3. **Terminals & SSH** — active terminals, SSH connects/failures by code, host-key mismatches, WS close codes.
4. **QE runner** — runs/day, pass rate, duration p95, cancellations.
5. **Security** — authz denials, SSRF blocks, host-key events, revocations, rate-limit hits, logins/failures.
6. **SLO** — error budget burn for API availability, workspace start, terminal open, SSH connect.

## 7. Alerts (each links to a runbook in `04_OPERATIONS/RUNBOOKS.md`)

| Alert | Condition (example) | Severity |
|---|---|---|
| API error rate high | 5xx > 2% for 5 min | page |
| Workspace starts failing | failure ratio > 10% for 10 min | page |
| SSH failure spike | failures > 5× baseline 15 min | ticket |
| Host-key mismatch | any `HOSTKEY_MISMATCH` | security notify |
| SSRF blocks spike | > 10 in 10 min | security notify |
| Audit write failure | > 0 | page |
| Vault credential failures | > 5% for 5 min | page |
| Session leak | active sessions − active WS > threshold for 30 min | ticket |
| DB pool saturation | > 90% for 5 min | page |
| Runtime node capacity | allocatable < 15% | ticket |
| Cert expiry (TLS/mTLS) | < 14 days | ticket |

## 8. SLOs (initial)

| SLI | SLO |
|---|---|
| API availability (non-5xx, excluding 4xx) | 99.9% / 30 d |
| Workspace start success within 90 s | 99% |
| Terminal open success within 3 s | 99% |
| SSH connect success (excluding target-down & auth-rejected) | 99% |
