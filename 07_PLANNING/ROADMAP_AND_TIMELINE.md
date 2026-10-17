# Roadmap and Timeline

Assumes a team of 5–7 (see TEAM_AND_RACI.md). Weeks are elapsed time; several phases run in parallel tracks.

| Week | Track A — IDE/Frontend | Track B — Backend/Broker | Track C — Platform/Sec | Milestone |
|---|---|---|---|---|
| 1–2 | P00 spikes S1–S3, S5 | P00 spike S4 | P00 org decisions | Decisions + ADRs |
| 2 | P01 monorepo | P01 | P01 CI | |
| 3–4 | P02 Theia shell (browser+Electron) | P03 control plane + DB | dev compose, kind | |
| 4–5 | P02 runtime image | P04 identity + RBAC | | |
| 5–7 | P05 router UI bits, P06 terminal E2E | P05 runtime providers + lifecycle | P15 CI expansion (start) | **M1** (wk 7) |
| 7–8 | qe-remote list view, admin UI | P07 targets/policy/tickets | Vault dev, SSH fixtures | |
| 8–10 | Remote terminal widget | P08 broker | | |
| 10–11 | qe-ssh FileSystemProvider | P09 remote FS | | **M2** (wk 11) |
| 11–13 | P10 desktop + local web, parity | P11 runner backend + remote exec | P12 Vault/SSH CA, corp OIDC | **M3** (wk 13) |
| 13–15 | P11 QE panel | P12 audit completeness | P13 observability, P16 Helm | |
| 15–17 | fixes | P14 hardening | P14 scans/pen test, P16 netpol | **M4** (wk 17) |
| 17–19 | perf fixes | P17 load/chaos fixes | P17 DR/rollback drills, P15 release | |
| 19–23 | P18 pilot (support, fixes) | P18 | P18 | **M5** GA decision (wk 22–24) |

## Critical path
P00 → P01 → P03 → P04 → P05 → P07 → P08 → P09 → P12 → P14 → P16 → P17 → P18.

## Cut lines if time is short
1. Desktop GA can follow web GA by one release (keep local web for laptop use).
2. Maven adapter after pytest.
3. Host-CA trust model after pinned fingerprints.
4. Phase 19 entirely post-GA.

## Never cut
Authz matrix, SSRF guard, host-key verification, secrets handling, audit, NetworkPolicies, backups, rollback.
