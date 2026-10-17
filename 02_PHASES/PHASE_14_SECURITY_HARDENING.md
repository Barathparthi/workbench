# Phase 14 — Security Hardening and Threat-Model Closure

| | |
|---|---|
| **Goal** | Every threat T1–T23 has a control, an automated test, evidence and an owner |
| **Duration** | 1.5–2 weeks |
| **Prerequisites** | Phases 01–13 |
| **Prompt pack** | `03_PROMPTS/PHASE_14_PROMPTS.md` |

## Step-by-step
1. **Threat walk-through** with security: update `01_ARCHITECTURE/07_SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md` with anything new; produce `docs/security/threat-register.md` columns: asset, boundary, threat, exploit path, control, test, evidence link, residual risk, owner.
2. **Gap tests**: for each threat without an automated test, write it in `tests/security/` (see `11_TESTING_STRATEGY.md` §5).
3. **HTTP hardening**: CSP tuned for Theia (verify Monaco workers/webviews), HSTS, COOP, frame-ancestors none, cookie flags, CORS denied by default.
4. **WebSocket hardening**: Origin checks on router and broker; max frame/message sizes; ping/pong; per-user connection caps.
5. **Rate limits** per `07_SECURITY §4.5` with Redis-backed store for multi-replica correctness.
6. **Input limits**: body sizes, header sizes, path lengths, JSON depth.
7. **Port forwarding**: confirm broker rejects all forwarding requests; test both directions.
8. **Extension governance**: hosted builds point only at internal Open VSX; plugin install restricted to allowlist; test non-allowlisted install fails.
9. **Container hardening review**: images non-root, minimal packages, no secrets in layers (`trivy config`, `dockle`).
10. **Dependency hygiene**: no Critical/High open; Renovate configured; licence scan.
11. **DAST**: OWASP ZAP baseline + authenticated scan against staging.
12. **Pen test**: scope = auth, authz/IDOR, SSRF, broker, WS, runtime escape, desktop token storage. Triage and fix.
13. **Incident runbooks**: credential compromise (rotate CA, revoke sessions), host-key mismatch storm, suspicious lateral movement.

## Exit criteria
- [ ] Threat register: all High risks closed or formally accepted with owner.
- [ ] Security test suite green in CI (blocking).
- [ ] DAST: no High; pen-test Critical/High fixed and retested.
- [ ] Security sign-off recorded.
