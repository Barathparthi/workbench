# Phase 17 — Performance, Reliability and Disaster Recovery

| | |
|---|---|
| **Goal** | Prove the SLOs under load, survive failures gracefully, and restore from backup |
| **Duration** | 1.5 weeks |
| **Prerequisites** | Phase 16 in staging |
| **Prompt pack** | `03_PROMPTS/PHASE_17_PROMPTS.md` |

## Step-by-step
1. **Capacity model**: per workspace profile CPU/mem; nodes needed for peak concurrency (A3); broker sessions per replica.
2. **Load tests (k6)** in `tests/load/`:
   - `terminal_ws.js`: 300 concurrent remote terminals, 10 msgs/s, measure echo p95.
   - `ssh_burst.js`: 50 session opens in 10 s.
   - `api_mix.js`: 200 RPS mixed reads/writes.
   - `workspace_storm.sh`: 40 starts in 2 min.
3. Find the first bottleneck (CPU, event-loop lag, Vault, DB pool, ingress) → fix or document limit → re-run.
4. **Soak** 8 h mixed: watch heap, fds, goroutine-equivalents (active handles), session table vs live WS.
5. **Chaos/failure injection** (staging): kill broker pod; kill workspace pod; restart PG (failover); Vault unavailable 5 min; block a target's network; expire IdP signing key; control-plane rolling restart during active terminals.
   Expected: clear user errors, correct states, audit entries, automatic recovery, no orphaned sessions.
6. **Backup/restore drill**: restore PG to a point in time in a scratch environment; restore a workspace PVC snapshot; measure RTO/RPO.
7. **Rollback drill**: deploy known-bad version → auto-rollback triggers → verify DB compatibility.
8. Record results in `docs/phase-gates/PHASE_17.md` with graphs.

## Exit criteria
- [ ] SLO targets met or formally re-baselined with stakeholders.
- [ ] Soak shows no leaks; chaos scenarios pass.
- [ ] Restore and rollback drills completed within RTO.
