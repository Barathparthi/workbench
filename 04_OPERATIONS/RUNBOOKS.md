# Runbooks

Format for each: **Symptom → Impact → Check → Mitigate → Verify → Escalate**. Commands assume namespace `qews-system` / `qews-workspaces`.

## RB-01 Workspace stuck in STARTING / start failures
- **Check**: `GET /api/v1/admin/runtimes`; `kubectl -n qews-workspaces get pod -l qews/workspace-id=<id> -o wide`; `kubectl describe pod …` (ImagePullBackOff? Pending — insufficient CPU? PVC not bound?); dashboard *Workspaces*.
- **Mitigate**: capacity → scale workspace node pool; image pull → check registry/digest; PVC → storage class events. Reconciler will mark FAILED after timeout; user retries Start.
- **Verify**: start p95 back under SLO; no STARTING older than 5 min.

## RB-02 IDE loads but terminal/explorer disconnected
- **Check**: WS close codes on *Terminals & SSH*; ingress timeouts; router logs by `workspaceId`; runtime pod restarts.
- **Mitigate**: ingress WS timeout config; restart workspace (Stop/Start); if many users → control-plane router replica health.

## RB-03 SSH connect failure spike
- **Check**: `qews.ssh.failures` by `error_code`.
  - `SSH_UNREACHABLE/TIMEOUT` on one target → target/network down → notify lab owner.
  - all targets → broker egress NetworkPolicy, DNS, or broker pods.
  - `CREDENTIALS_UNAVAILABLE` → Vault (RB-05).
  - `CREDENTIALS_REJECTED` → target CA trust (`TrustedUserCAKeys`) or principal mapping changed.
- **Verify**: canary synthetic SSH check green.

## RB-04 Host-key mismatch alert (SECURITY)
- **Treat as potential MITM until proven otherwise.**
- **Check**: which target(s); was the host rebuilt/rekeyed (change record)? Compare fingerprint from the console out-of-band.
- **Mitigate**: if legitimate rekey → admin revokes old key, approves new one (audited). If not explained → disable target, notify security, preserve logs.
- **Never** bypass verification.

## RB-05 Vault / secret manager unavailable
- **Impact**: new SSH sessions fail; existing sessions continue.
- **Check**: Vault health, broker logs `credentials.resolve` spans, Kubernetes auth role.
- **Mitigate**: Vault HA failover per Vault runbook; communicate degraded remote access.

## RB-06 Audit write failures (page)
- **Impact**: privileged actions fail closed (by design).
- **Check**: DB health, disk, `audit_events` partition for current month exists, advisory-lock contention.
- **Mitigate**: create missing partition; fix DB; verify chain with verifier job after recovery.

## RB-07 Revoke a user immediately (offboarding/incident)
1. Disable in IdP. 2. `POST /api/v1/users/{userId}/sessions:revoke` (admin). 3. Stop their workspaces. 4. Confirm `SESSION_REVOKED` audit events and zero active sessions for the user.

## RB-08 Compromised SSH CA / credential (SECURITY)
1. Disable affected Vault signing role. 2. Revoke all sessions (`sessions:revoke` for all or by target tag). 3. Rotate CA keypair; push new `TrustedUserCAKeys` via config management; add old CA to `RevokedKeys`. 4. Re-enable role. 5. Review audit for issued cert serials in window.

## RB-09 Broker pod restart / deploy
- Sessions on that pod close with 4013/`BROKER_RESTART`; users reconnect. Check that the session table has no ACTIVE rows for the old pod after 2 min (reconciler).

## RB-10 Database failover / restore
- Managed PG failover: app reconnects (pool retry). Point-in-time restore: follow provider PITR procedure into a new instance → update secret ref → rolling restart → verify `/readyz` and audit chain.

## RB-11 Workspace data restore
- Find VolumeSnapshot for the PVC → create PVC from snapshot → stop workspace → swap claim (admin script) → start → user verifies files.

## RB-12 Rollback a release
- `helm -n qews-system rollback qe-workspace <rev>` (or revert in Argo CD) → post-deploy verification job → confirm error rates. Migrations are N-1 compatible; do not roll back contract migrations.

## RB-13 Desktop app cannot sign in
- Check managed policy file for control plane URL; loopback redirect blocked by local firewall/AV; system browser default; clock skew; IdP public client redirect URIs include `http://127.0.0.1/*` pattern per IdP rules.
