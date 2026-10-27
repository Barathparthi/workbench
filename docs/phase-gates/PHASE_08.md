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

**2026-10-25, first local run (WSL Ubuntu + Docker Engine), after merging `main`:** 77/77 integration tests and
1035/1035 unit tests pass; format, lint and typecheck clean. The first run found three defects, all fixed:

- OpenSSH test image: sshd keeps the first value of each keyword and Alpine's config already sets
  `AuthorizedKeysFile`, so the appended settings (authorized-keys path and the hardening lines) were ignored and
  every key login failed. The settings now go first and the build asserts the effective value with `sshd -T`.
- `targets.int.test.ts` never wired `closeOnBroker`, so "revocation reaches the broker" could not pass.
- The Ctrl+C test matched `SLEPT` in the PTY's echo of the typed command; the marker is now `SL""EPT`.

`apps/connection-broker` moves to Fastify 5.12.7 to match the control plane (PR #12).

**2026-10-26/27 — Milestone M2 end to end (WSL Ubuntu, Docker Engine 29.9.2, Node 24.22.0).** Stack: compose
PostgreSQL + Keycloak, control plane (:8080, `AUTH_MODE=dev`, roles `qe.admin,qe.user,lab.a.user`), broker (:8082,
`file_dev` key), workspace runtime image from `main`, and an OpenSSH container as lab machine (`qews-lab-a`,
image `qews-lab-openssh:dev`, network `qews-lab`, fixed 172.30.0.10). Registered through the admin API: policy
(`lab.a.user`, 172.30.0.0/24, port 22, `terminal`), `file_dev` credential reference, target `lab-a-dev` (principal
`qe`), host key approved from the container's `ssh_host_ed25519_key.pub` (same fingerprint as `ssh-keygen -lf`).

1. Headless, through a throwaway control plane and broker (`ws` client speaking `qews.v1`):

   ```text
   session … AUTHORIZED stream=http://localhost:8092/api/v1/sessions/…/stream
   control {"t":"status","state":"CONNECTING"}
   control {"t":"hostkey","algorithm":"ssh-ed25519","fingerprintSha256":"SHA256:OllhDjWvCr/L2LwG0G/EsTMm1eUwF6P7NtCWOyA0tMo","verified":true}
   control {"t":"status","state":"ACTIVE"}
   REMOTE OUTPUT: M2-OK qe@bd719bc262a6 size=24 80     ← requested 100x30: defect 3 below
   closed 1000 client_closed                           ← session row CLOSED client_closed
   ```

2. In the browser: workspace IDE at `/w/{id}/` → F1 → Connect to Remote System → `lab-a-dev`:

   ```text
   Connecting to lab-a-dev…
   Host key verified (ssh-ed25519 SHA256:OllhDjWvCr/L2LwG0G/EsTMm1eUwF6P7NtCWOyA0tMo).
   Welcome to Alpine!
   7025eca211d5:~$
   ```

   Session row `ACTIVE`, broker instance recorded; audit `REMOTE_CONNECT_ALLOWED`, `SSH_SESSION_OPENED`. A first
   attempt, after the lab container changed address on a WSL restart, failed cleanly as `SSH_CONNECT_FAILED` /
   `SSH_TIMEOUT` ("The remote system did not answer in time").

Defects found by the M2 run, all fixed with tests:

1. Runtime image built only `qe-core`; `qe-remote` had no `lib/` and the IDE stopped at startup
   (`Dynamic require of "@qe/theia-qe-remote/…" is not supported`). Now builds every extension (`-w extensions`).
2. Router CSP blocked Monaco's `data:` WebAssembly and the broker stream: `connect-src 'self' data:` plus the broker's
   ws/wss origin from `BROKER_PUBLIC_URL`.
3. Requested terminal size was dropped: the control plane returned `terminal: null` and the broker hard-coded 80×24.
   Migration `0004_session_terminal_size` stores it; the broker uses it. Unit test (broker) and integration test
   (control plane) added.
4. Image build hung 25 minutes downloading Node headers through the proxy; node-gyp now uses the base image's headers.

Local bundles (`npm run build` after the merge): `ide-browser` and `ide-electron` both contain the Connect to Remote
System command, no unresolved requires. Unit tests 1039/1039; integration suites pass (targets 23, db 18).

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

- ~~Milestone M2~~ — done 2026-10-27 (see Validation).
- Sweep of stale `CONNECTING` sessions when a broker dies mid-connect (reconciler, with Phase 09/13).
- The IDE sends 80×24 when it opens the session (the terminal widget is measured after connect) and corrects it with
  a `resize` once the socket opens; measuring first would make the initial PTY size exact.
- `npm warn Unknown env config "nodedir"` during the image build: works with npm 11, will stop in the next npm major;
  replace before upgrading npm.
- Open VSX downloads redirect to `openvsx.eclipsecontent.org`, which intermittently stalled behind the proxy and failed
  two image builds; `scripts/plugins.ts` has a single 60 s attempt — add retries (Phase 15, or with D7's mirror).
- The CI `runtime image` job does not load the IDE frontend, so defect 1 above passed CI; a frontend smoke against the
  image belongs in Phase 15.
- One unit-suite failure in `broker-core` `index.test.ts` was seen once under heavy load (passes alone and on rerun);
  watch for flakiness.

## Decision

- [x] PASS — 2026-10-27: M2 met in the browser (host key verified, interactive shell, audited); local builds of both
      IDE apps include the extension. Owner to confirm the GitHub Actions run for the pushed commit is green.
- [ ] ~~CONDITIONAL — integration suites pass locally (2026-10-25); pending CI (`smoke`: both IDE apps build with the
      new extension) and an M2 run (browser → broker → SSH target)~~
- [ ] FAIL
