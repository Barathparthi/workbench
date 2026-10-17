# Production Readiness Checklist

Tick only with an **evidence link** (phase gate, test report, dashboard screenshot, sign-off).

## Product
- [ ] Hosted web: SSO → workspace → edit/save → terminal → tests (evidence: E2E report)
- [ ] Local web: same flow, localhost-only, token-protected
- [ ] Desktop (Win/macOS/Linux): same flow; signed installers
- [ ] Remote: managed target terminal + file edit; personal target (desktop/local)
- [ ] QE runner: pytest (and Maven if in scope), results, reports, cancel
- [ ] Parity suite green in all modes

## Security
- [ ] Corporate OIDC; roles from groups; MFA via IdP
- [ ] Authz matrix tests green; every route declares a permission
- [ ] No keys/passwords/tokens in browser storage, logs, traces, audit (leak scan)
- [ ] Host-key verification enforced; mismatch alerting tested
- [ ] SSRF tests green; broker connects to pinned IPs only
- [ ] Traversal/symlink suite green
- [ ] Port/agent/X11 forwarding disabled (tested)
- [ ] Short-lived SSH certificates in use (or approved exception)
- [ ] Workspace isolation tests green (HTTP, WS, network, filesystem)
- [ ] PSS restricted, NetworkPolicies, admission policies enforced
- [ ] SAST/SCA/secret/image/IaC scans clean or excepted; DAST no High; pen test closed
- [ ] Threat register signed off by security

## Reliability
- [ ] SLOs met in load tests; soak without leaks
- [ ] Chaos scenarios pass; graceful shutdown verified
- [ ] Backups configured; PG PITR and PVC restore drills done (RTO/RPO recorded)
- [ ] Rollback drill done
- [ ] Quotas, idle stop, rate limits configured

## Observability
- [ ] Traces/metrics/logs flowing with correlation; no sensitive attributes
- [ ] 6 dashboards live; alerts tested in game day; every alert has a runbook
- [ ] Audit viewer + export; hash-chain verifier job + archive

## Delivery
- [ ] CI gates mandatory; signed images by digest; SBOMs stored
- [ ] Staging E2E + load gate automated; prod approval gate configured
- [ ] Post-deploy verification with auto-rollback

## Support
- [ ] Owners named; on-call rota; escalation paths
- [ ] User guide, admin guide, known limitations published
- [ ] Upgrade cadence (Theia, Node, deps, base images) scheduled
