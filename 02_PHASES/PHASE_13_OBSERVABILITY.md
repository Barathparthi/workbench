# Phase 13 — Observability

| | |
|---|---|
| **Goal** | On-call can tell whether a failure is in control plane, runtime, broker, target, or test process — without guessing |
| **Duration** | 1 week |
| **Prerequisites** | Phases 03–12 (instrument what exists) |
| **Prompt pack** | `03_PROMPTS/PHASE_13_PROMPTS.md` |

## Step-by-step
1. **`packages/telemetry`**: `initTelemetry({ serviceName })` using `@opentelemetry/sdk-node`, OTLP exporter, resource attrs, HTTP/pg/fastify auto-instrumentation; `getLogger()` (pino with trace correlation + redaction); metric name constants.
2. Call `initTelemetry` **first** in each service entrypoint (`--require`/`--import` preload).
3. Manual spans for: authz, policy, ticket mint/redeem, SSRF check, credential resolve, ssh connect/hostkey/channel, runtime start, runner start/finish (`01_ARCHITECTURE/10_OBSERVABILITY.md` §3).
4. Metrics from §4 of that doc; enforce label allowlist in a helper (reject high-cardinality labels at dev time).
5. Theia backend in runtime: lightweight metrics (terminal counts, runner) exported via OTLP to the collector (runtime NetworkPolicy allows only collector).
6. Collector config in `deploy/observability/otel-collector.yaml`: batch, memory_limiter, attributes processor that **deletes** any accidental sensitive attributes (`http.request.header.authorization`, `cookie`, etc.).
7. Dashboards as code (6 dashboards) and alert rules with runbook links.
8. Synthetic checks: login + workspace start + SSH canary every 5 min in staging/prod.
9. Write runbooks for every alert (`04_OPERATIONS/RUNBOOKS.md`).

## Tests
- Unit: logger redaction canary; label allowlist.
- Integration: collector file exporter in tests → assert spans for the SSH connect flow exist with expected attributes and **no** forbidden ones.
- Game day: trigger each alert in staging (stop Vault, swap host key, kill broker) and confirm alert → runbook → diagnosis.

## Exit criteria
- [ ] Failed SSH connect, failed terminal, failed test run each diagnosable from telemetry alone (game-day evidence).
- [ ] Dashboards and alerts deployed via code; every alert links to a runbook.
