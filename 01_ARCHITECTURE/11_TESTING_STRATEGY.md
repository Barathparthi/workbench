# 11 — Testing Strategy

## 1. Pyramid and ownership

```text
                 ┌──────────┐  E2E + parity (Playwright: hosted, local-web, desktop)   ~40 tests
               ┌─┴──────────┴─┐ Load / soak / chaos (k6, scripts)                      nightly/weekly
             ┌─┴──────────────┴─┐ Security tests (authz matrix, SSRF, traversal, WS)   ~300 generated
           ┌─┴──────────────────┴─┐ Contract tests (OpenAPI, WS protocol, internal API)
         ┌─┴──────────────────────┴─┐ Integration (Testcontainers: PG, OpenSSH, Vault, K8s-kind)
       ┌─┴──────────────────────────┴─┐ Unit (Vitest): domain, rbac, policy, confine, state machines
```

## 2. Test environments & fixtures

| Fixture | Image / tool | Used for |
|---|---|---|
| PostgreSQL | `postgres:<pinned>` via Testcontainers | Repos, migrations, audit grants |
| OpenSSH server | `linuxserver/openssh-server` or custom Alpine/Debian sshd image with known host key + user CA trust | Broker integration |
| SSH server with **different** host key | Same image, regenerated key | Host-key mismatch |
| Vault dev | `hashicorp/vault` dev mode + SSH secrets engine | Cert issuance |
| Fake IdP | `dex` or Keycloak container, or `oidc-provider` in-process | Auth flows |
| Fake DNS | small `dns2` server in test | DNS rebinding tests |
| kind cluster | `kind` | Runtime provider, NetworkPolicy tests (with Calico/Cilium) |
| Sample QE repo | `tests/fixtures/sample-pytest-repo` | Runner, E2E |

All fixtures start from `packages/test-utils`, e.g. `await startSshServer({ hostKey, users })`.

## 3. Unit test focus list

- State machines: every legal transition, every illegal transition rejected, idempotency.
- RBAC evaluator: table-driven from the permission matrix.
- Policy evaluator: roles × capability × target status × policy version.
- SSRF guard: IPv4/IPv6, mapped IPv6 (`::ffff:127.0.0.1`), decimal/octal IP forms (`2130706433`, `0177.0.0.1`), link-local, metadata IPs, CGNAT, cluster CIDRs.
- `confine()`: traversal corpus (see §6).
- Ticket: single use, expiry, binding to user/session/origin.
- Redaction: canary object never appears in serialized logs.
- JUnit parser: pytest, Surefire, malformed XML, huge files (streaming parser).
- WS protocol codec: oversized frames, unknown types, bad JSON.

## 4. Integration tests

- Control plane + PG: migrations up from empty; repository CRUD; CAS state updates under concurrency
  (`Promise.all` of 20 starts → exactly one transition).
- Broker + OpenSSH: connect, PTY echo, resize (`stty size`), SIGINT (`sleep 100` interrupted), exit code,
  SFTP ops, symlink escape (`ln -s /etc root/escape`), large file limit, idle timeout, revoke.
- Broker + Vault: cert TTL, principals, failure when Vault down → `CREDENTIALS_UNAVAILABLE`.
- Runtime provider (kind): create pod, readiness, stop, PVC retained, NetworkPolicy blocks egress.

## 5. Security test suites (`tests/security`)

| Suite | Method |
|---|---|
| **Authz matrix** | Generated from `rbac` matrix × route table: for each route and role, assert allow/deny; includes cross-tenant IDOR (user A's IDs used by user B) |
| **SSRF** | Register/connect to forbidden addresses & rebinding names → denied, **no TCP SYN** (assert via test server not receiving connection) |
| **Host key** | Mismatch / unknown / revoked → fail closed + audit + metric |
| **Traversal** | Corpus against remote FS and runner artifact endpoints |
| **WebSocket** | No ticket, reused ticket, other user's ticket, wrong Origin, expired ticket, oversized frame |
| **CSRF/Origin** | Unsafe methods without token / wrong origin |
| **Leak scan** | Run E2E with canary secrets; grep logs, traces (collector file exporter), audit, HTTP responses, browser storage |
| **Container policy** | Admission tests: privileged pod, root user, hostPath → rejected |
| **Rate limits** | Burst beyond limits → 429 with Retry-After |
| **DAST** | OWASP ZAP baseline against staging |

## 6. Traversal corpus (excerpt)

```text
../etc/passwd            ..\..\windows\win.ini      %2e%2e/%2e%2e/etc/passwd
..%2f..%2fetc            /etc/passwd                C:\Windows\win.ini
foo/../../bar            foo/./../..                ./....//....//etc
symlink-to-etc/passwd    dir/symlink-to-parent/..   name-with-\0-null
very long path (>4096)   unicode homoglyph ‥/        trailing-dot-segment/..
```
Expected: `PATH_OUTSIDE_ROOT` (or `INVALID_REQUEST`), never a normalized escaped path.

## 7. E2E (Playwright)

Critical journeys (each in `hosted`, `local-web`; desktop nightly):
1. Login → workspace list → start → IDE ready.
2. Open file → edit → save → reload → content persisted.
3. Terminal: `echo QE_OK` visible; `sleep 100` + Ctrl+C → prompt returns; resize → `tput cols` matches.
4. Remote: list targets → connect → `hostname` → resize → disconnect → audit visible (admin).
5. Remote files: open, edit, save, conflict (modify on server via side channel → 409 → dialog).
6. Runner: run sample suite → live output → results tree shows 3 pass / 1 fail → open report.
7. Negative: unauthorized user sees no target; direct API connect → 403; no SSH attempt.

Use Theia-aware selectors (`@theia/playwright` page objects) and avoid sleeping — wait for states.

## 8. Load, soak, chaos

| Test | Tool | Target |
|---|---|---|
| Terminal concurrency | k6 WS: 300 sessions × 10 msgs/s | p95 echo < 100 ms, broker CPU < 70% |
| SSH burst | k6: 50 connects in 10 s | success ≥ 99%, Vault latency OK |
| Workspace start storm | script: 40 starts in 2 min | p95 < 90 s, no stuck STARTING |
| API | k6 HTTP 200 RPS mixed | p95 < 300 ms |
| Soak | 8 h mixed load | no memory growth > 10%, no fd/session leaks |
| Chaos | kill broker pod, kill runtime pod, restart PG, block Vault, drop target network | correct states, audit, user-visible errors, recovery |

## 9. Quality gates

| Gate | Threshold |
|---|---|
| Unit coverage | domain/rbac/policy/broker-core ≥ 90% lines; others ≥ 75% |
| Mutation testing (optional, Stryker) on `policy`, `confine`, `rbac` | score ≥ 70% |
| Flaky tests | quarantined within 24 h, fixed within 1 week |
| PR runtime | < 15 min for required checks |
