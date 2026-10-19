# Phase Gate — Phase 08: SSH Connection Broker and Remote Terminal

**Date:** 2026-10-19 · **Branch:** `phase-08-ssh-broker` (stacked on `phase-07-targets-policy`; owner pushes and merges) ·
**Reviewers:** @Barathparthi

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_08_SSH_BROKER_AND_REMOTE_TERMINAL.md`.
Decisions: ADR-002 (+ S4 addendum), ADR-006 (option B). Spikes reused: S3 (stub broker, Theia pseudo-terminal), S4 (ssh2).

## Deliverables

| Deliverable                                 | Status                                                                                                                                                                                                                                                                                                                                  | Evidence                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `@qe/broker-core`: `SshTransport` over ssh2 | done — verifier mandatory (connect refuses without one), pinned algorithm lists (no SHA-1 host keys, no CBC), 10 s ready timeout, keepalive, agent/X11 off, remote-initiated forwards rejected                                                                                                                                          | `ssh-transport.ts`                                   |
| `HostKeyVerifier`                           | done — OpenSSH SHA256 fingerprints; `unknown` (nothing trusted) vs `mismatch` (possible MITM); fails during key exchange, before any credential (proven against the in-process server: no auth attempt reaches it)                                                                                                                      | `host-key.ts`                                        |
| Error mapping                               | done — by ssh2 level / errno: `CREDENTIALS_REJECTED`, `SSH_TIMEOUT`, `SSH_UNREACHABLE`, host-key codes from our verifier                                                                                                                                                                                                                | `errors.ts`                                          |
| Terminal bridge (`qews.v1`)                 | done — queues input/control that arrive before the shell (S3), resize → `setWindow`, Ctrl+C → `0x03` through the PTY (S4), SIGQUIT → `0x1c`, SIGTERM ends the shell; backpressure pauses the PTY above 1 MiB buffered; idle and absolute timers (4010); protocol violations close 4008; idempotent close with one result                | `terminal-bridge.ts`, codec in `@qe/contracts`       |
| Session registry, revocation, drain         | done — close one / a user's / all; internal close endpoints (service token) → 4011; SIGTERM: readiness 503, new streams refused, grace period, then 4013                                                                                                                                                                                | `session-registry.ts`, broker `server.ts`, `main.ts` |
| `apps/connection-broker`                    | done — WebSocket upgrade needs an allowed Origin and the ticket subprotocol; ticket redeemed with the control plane **before** the upgrade completes and must match the session in the path; per session: port in policy, address re-checked against the policy (DNS may have changed), credential resolved, host key pinned, then PTY  | `server.ts`, `session-runner.ts`                     |
| Dev credential source                       | done — `file_dev` key files under `DEV_CREDENTIALS_DIR` only (no `..`, no symlinks out); refused in production by config; Vault in Phase 12                                                                                                                                                                                             | `credentials.ts`                                     |
| Control plane: state reports + revocation   | done — `POST /internal/v1/sessions/{id}/state` moves CONNECTING → ACTIVE / FAILED and live → CLOSED, audited (`SSH_SESSION_OPENED`, `SSH_SESSION_CLOSED` with byte counts and duration, `SSH_CONNECT_FAILED`, `SSH_HOST_KEY_MISMATCH/UNKNOWN`, `SSRF_BLOCKED` at connect); late/repeated reports ignored; admin revoke calls the broker | `remote-session-service.ts`                          |
| IDE: Connect to Remote System               | done — browser: target quick pick → session → Theia pseudo-terminal on the broker stream (ticket as subprotocol), host-key line, friendly errors and close reasons; desktop: explains that remote systems arrive with desktop sign-in (Phase 10, R17)                                                                                   | `extensions/qe-remote`                               |

## Validation (real output, trimmed)

Local: Windows 11, Node 24.22.0, no Docker.

```text
$ npm run typecheck        → exit 0
$ npm run lint             → 0 problems
$ npm run format:check     → All matched files use Prettier code style!
$ npx vitest run --project unit
 Test Files  41 passed (41)
      Tests  1035 passed (1035)
```

Run locally without Docker thanks to ssh2's own server: real handshakes (pinned key, mismatch with no auth attempt,
unknown key, rejected key, closed port), PTY size/resize/Ctrl+C/exit, and the **broker end to end** — a real WebSocket
client through the broker to SSH (17 tests: happy path, Origin/ticket/path refusals, host-key mismatch, DNS changed
to the metadata address, address outside policy, jump host, port, missing credential, revocation, drain).
`@qe/broker-core` coverage: 96.9 % lines, 91.5 % branches, 96.5 % functions.

CI only (Docker): `openssh.int.test.ts` (real OpenSSH: ssh-keygen fingerprint, `stty size`, Ctrl+C → exit 130,
mismatch, rejected key) and `targets.int.test.ts` (state reports, revocation, security audit events).

## Security review

- **Threats**: T7 host-key spoofing (pinned, fail closed, separate audit event), T5/T6 (address re-checked at connect,
  connect to the checked IP), T12 (Origin + single-use ticket subprotocol, session id bound), T13 (no forwards, agent,
  X11), T8 (key material only in broker memory; never in snapshot, logs, audit; ticket and subprotocol header
  redacted in logs), T16 (backpressure, frame limits 64 KiB/16 KiB, per-broker session cap, idle/absolute timeouts),
  T23 (admin revocation reaches the broker).
- **P9 kept**: the IDE talks to the control plane and broker from the browser page; the workspace runtime has no part in it.

## Deviations from the guide (recorded)

- Jump hosts are refused (`TARGET_NOT_ALLOWED`) until Phase 19; the snapshot carries `jumpHostId`.
- Host-key **scan** for admins is not added yet (approve by public key or fingerprint, Phase 07).
- Desktop remote terminals wait for the Electron-backend relay (Phase 10).
- In production the ingress routes `/api/v1/sessions/{id}/stream` to the broker (Phase 16); development uses
  `BROKER_PUBLIC_URL`.
- Credentials: development key files only; SSH certificates via Vault in Phase 12 (with the S4 ssh2 patch).

## Known limitations & follow-ups

- **Milestone M2** (browser → registered lab host → SSH terminal) end to end needs the control plane, broker, IDE and
  an SSH target running together — Docker on this PC or a staging environment.
- Sweep of stale `CONNECTING` sessions when a broker dies mid-connect (reconciler, with Phase 09/13).

## Decision

- [ ] PASS
- [x] CONDITIONAL — pending CI (`integration + coverage`: OpenSSH and PostgreSQL suites; `smoke`: both IDE apps build
      with the new extension) and an M2 run with Docker
- [ ] FAIL
