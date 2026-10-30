# Phase Gate — Phase 10: Local Desktop and Local Web

**Date:** 2026-10-30 · **Branch:** `phase-10-local-desktop` (stacked on `phase-09-remote-fs`; owner opens the PR) ·
**Reviewers:** @Barathparthi

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_10_LOCAL_DESKTOP_AND_LOCAL_WEB.md`. Prompts:
`03_PROMPTS/PHASE_10_PROMPTS.md` (P10.1–P10.7). Decisions: ADR-008 addendum (embedded broker in qe-remote's backends),
ADR-013 (managed settings, `reg.exe` read-only on Windows).

Owner's decision in the review (2026-10-30): a terminal no page has been attached to for 30 minutes is ended, and a
fresh layout starts none.

Plan decisions approved before implementation (2026-10-28): (1) unsigned installers, signing wired to environment
variables — a gate condition; (2) desktop tested on Windows and Linux locally, macOS in CI nightly; (3) the control
plane and broker accept IdP bearer tokens (never for cookies; `file://` and `null` origins stay refused, R17);
(4) new pinned dependencies `ssh-config` and `electron-builder`; (5) trust on first use on by default, with an org
switch; (6) two gates: **10a** (P10.1–P10.3 and local web) and **10b** (sign-in, installers, parity). Later owner
decisions: managed settings on Windows through `reg.exe`, read-only (ADR-013); webviews in local web on their own origin
`<uuid>.webview.localhost`.

## Deliverables

| Deliverable                       | Gate | Status                                                                                                                                                                                                                                                                                                            | Evidence                                                                                  |
| --------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Embedded broker                   | 10a  | done — in the Electron backend and, with `QE_MODE=local-web`, the Node backend; Theia RPC; terminal streams carry the same `qews.v1` frames; files through the same `RemoteFileSystem`, rooted at the remote home                                                                                                 | `qe-remote/src/node/embedded-broker.ts`                                                   |
| Personal targets                  | 10a  | done — `~/.ssh/config` and `~/.qe-workspace/ssh_hosts` with `ssh-config`'s parser only (its `compute()` can run processes); "Add SSH Host…" writes QE's own file, never `~/.ssh/config`                                                                                                                           | `broker-core/src/ssh-config-targets.ts`, `qe-remote-contribution.ts`                      |
| Credentials on the user's machine | 10a  | done — agent first (`SSH_AUTH_SOCK`; Windows OpenSSH pipe, then Pageant), then key files; passphrases asked only after a refusal, kept for the connection; nothing is sent to the control plane                                                                                                                   | `broker-core/src/personal-credentials.ts`                                                 |
| Host keys (`known_hosts`, TOFU)   | 10a  | done — hashed and plain entries, wildcards, `@revoked`; unknown → "Trust once / Trust and save / Cancel" with the SHA256 fingerprint; mismatch → OpenSSH-worded hard error, no override; TOFU switchable by managed setting                                                                                       | `broker-core/src/known-hosts.ts`, `host-key-dialog.ts`                                    |
| One connection client             | 10a  | done — managed (control plane / relay) and personal (embedded) targets in one picker; terminals and `qe-ssh://` folders behave the same                                                                                                                                                                           | `qe-remote/src/common/connection-client.ts`                                               |
| Local web mode                    | 10a  | done — nothing served without the HttpOnly, SameSite=Strict cookie from the run's link; loopback Host only; refuses to listen off loopback outside its container (exit 78); compose profile and `qe-workspace-local` launchers (bash, PowerShell)                                                                 | `qe-core/src/node/qe-local-web-auth.ts`, `deploy/compose/docker-compose.local-web.yml`    |
| Desktop sign-in                   | 10b  | done — authorization code + PKCE through the system browser, one-shot `127.0.0.1` loopback; refresh token with `safeStorage` (never plain text), access token in memory; managed targets through a backend relay; control plane verifies the IdP's tokens (JWKS, issuer, audience, `azp`, expiry, lifetime ≤ 1 h) | `qe-remote/src/electron-node/desktop-account.ts`, `control-plane/src/auth/bearer-auth.ts` |
| Installers                        | 10b  | partial — Windows NSIS, macOS dmg, Linux AppImage and deb with the built-in plugins; **unsigned** (signing only from environment variables, D15); no update channel (D17)                                                                                                                                         | `apps/ide-electron/electron-builder.yml`, `.github/workflows/desktop.yml`                 |
| Managed settings                  | 10b  | done — `HKLM\Software\Policies\QEWorkspace` (`reg.exe`, no shell) or `policy.json`; one strict shape; invalid → the app stops (exit 78) naming the source                                                                                                                                                         | `qe-core/src/node/qe-managed-settings.ts`, ADR-013                                        |
| Parity suite                      | 10b  | done — one set of scenarios in `parity-hosted`, `parity-local-web`, `parity-desktop`, each result checked outside the IDE; desktop nightly on three OSes                                                                                                                                                          | `tests/parity/`                                                                           |

## Validation (real output, trimmed)

Windows (no Docker), commit `6c6729d`:

```text
$ npm run typecheck        → exit 0
$ npm run lint             → exit 0
$ npm run format:check     → All matched files use Prettier code style!
$ npx vitest run --project unit
 Test Files  65 passed (65)
      Tests  1577 passed (1577)
```

WSL Ubuntu; runtime image `9624a207bc04` built from `6c6729d`, workspace restarted
on it; hosted suites on `414c83d` (test-only changes after `6c6729d`):

```text
$ npm run test:integration (2e2e65f)              Test Files 12 passed (12)   Tests 134 passed (134)
$ npx playwright test --project hosted            3 passed (59.7s)   — again: 3 passed (1.1m)
$ npx playwright test --project parity-hosted     7 passed, 1 skipped (2.4m) — again: 7 passed, 1 skipped (2.1m)
$ npx playwright test --project browser           20 passed (5.6m)
$ npx playwright test --project local-web-security  6 passed (4.3s)
$ npx playwright test --project electron          4 passed (28.4s) — again: 4 passed (20.0s)
$ npx playwright test --project parity-local-web  9 passed (2.2m) — again: 9 passed (2.2m)
$ xvfb-run -a npx playwright test --project parity-desktop
                                                  8 passed (4.2m)
```

The skipped hosted scenario is the webview (`fixme`, D9). Not hidden:

- `parity-desktop` failed twice at the same step in full runs (after browser, local-web security, electron and local
  web parity): "opens a terminal on the target" waited 30 s for the `lab-a` row of the host picker to become visible
  and stable. It passed 8/8 in three other runs, including one in exactly that order with page snapshots kept; the
  cause is not known. Condition 4 below (the `desktop` workflow) watches it.
- The first integration run of the day, straight after the E2E suites, reported 4 files failed and 39 tests skipped,
  without its cause captured; the rerun on the same commit passed 134/134.

## Defects found during the phase review

- **A remote save could silently overwrite a change made on the server** (`6066083`). The browser auto-saves after
  1 s and SFTP mtimes have whole seconds; Theia's "modified since" only counts a later mtime, so an auto-save and a
  change on the server within one second passed it. The server's `ifMatch` did not catch it either: Theia reads the
  file (for its encoding) right before each write, which refreshed the ETag the provider sent. Remote files now count
  any other mtime or size as changed (`QeFileService`, scoped to `qe-ssh` stats), so the save asks. Phase 09's hosted
  test had passed by timing.
- **Terminals leaked until the IDE refused new ones** (`6c6729d`, owner's decision 2026-10-30: 30 minutes). Theia
  starts a terminal in every fresh layout, and terminals outlive the page (so a reload reattaches); nothing ended one
  a page had left for good. Each new browser, device or private window kept one running, and after 10 the IDE
  refused every new terminal until the workspace restarted — found when the parity suite ran after other hosted
  suites (`QE: terminal refused — limit of 10 open terminals reached`). Present since Phase 02/06. A fresh layout now
  starts no terminal, and a terminal no page has been attached to for 30 minutes is ended
  (`QE_TERMINAL_DETACHED_MINUTES`, 1–1440), in every mode.
- The embedded broker reported unexpected failures as `INTERNAL_ERROR` with nothing logged (`c416ce4`): now one
  bounded line with the error's kind and message.
- Opening a link out of a remote folder did nothing (`dd6ed0a`): it now says why.
- "Add SSH Host…" (guide 10.2) was missing (`43b2382`).
- Test hygiene: hosted tests ended neither their remote sessions (per-user limit 5) nor their multi-root workspace,
  and the conflict test raced the auto-save; the hosted suites now open the project folder by name (`e527269`,
  `c32fdf8`, `f6d7e5b`, `2e2e65f`).

## Security review

- **Threats**: local web reached by other local users or web pages (DNS rebinding) — cookie from the run's link,
  loopback Host only, loopback bind; bearer tokens (forged, wrong audience/client, ID or refresh tokens presented) —
  verified by the control plane only, tickets bound to `qe-desktop`; desktop secrets — refresh token through the OS
  keychain only, the backend's private channel token removed from its environment, renderer gets status only; personal
  hosts — org deny list before connect, `known_hosts` fails closed on mismatch and `@revoked`; config injection through
  "Add SSH Host…" — every value must match the reader's patterns; unpacking plugin archives (`decompress` advisories) —
  replaced by a maintained fork; data loss on conflicting saves — above.
- **Controls added**: local-web guard ahead of Theia's middleware; WebSocket validator; `0.0.0.0` refused outside the
  container (exit 78); webview origin may `GET /webview/*` only; managed settings fail closed; `shell.openExternal` only
  for http(s); local audit log (connections, file changes, hosts added).
- **Negative tests**: local web without cookie / wrong token / foreign Host / non-loopback address; Keycloak tokens on
  wrong redirect paths, ID and refresh tokens refused; the private channel not visible from a terminal; changed and
  revoked host keys; TOFU off; malformed hosts and duplicate names in "Add SSH Host…"; `decompress` traversal, absolute
  paths, symlink chains and hard links.

## Operational review

- Logs: the backend logs neither the local-web token nor tokens of the desktop sign-in; embedded-broker warnings
  carry the error's kind and message only.
- Audit: `AUTH_LOGIN_SUCCESS` with method `desktop_token`, once per IdP session; personal connections, file changes
  and added hosts in the local audit log (`~/.qe-workspace`).
- Metrics, alerts and runbooks: Phase 13.

## Parity (browser / local web / desktop)

Same scenarios in all three modes (see Validation). The webview scenario is `fixme` in hosted only: hosted webviews
need wildcard DNS and TLS for `*.webview.<host>` and the router (ADR-005, D9). "Run the pytest sample" arrives with
the QE runner (Phase 11). Personal hosts exist only in the local modes; hosted SSH stays limited to registered targets
(rule 3).

## Deviations from the guide (recorded)

- The local-web token is reusable for the run (Jupyter-style), not one-time, and the backend never prints it; the
  launcher shows the link in the user's terminal, or it is written to `~/.qe-workspace/local-web-url` (0600).
- `@cert-authority` lines are read but not used: host certificates are not among the algorithms the transport
  negotiates. Trusted keys are written to `~/.qe-workspace/known_hosts`, never to `~/.ssh/known_hosts`.
- "Add SSH Host…" takes `user@host:port`; key files and other options are edited in the file itself.
- Installers are unsigned until D15; `asar` is off as in Theia's packaging; no auto-update or software-centre channel
  until D17.
- Managed settings `openVsxUrl` and `telemetry` are validated and carried, not applied yet (ADR-012; Phase 13).
- Desktop refresh tokens are ordinary ones: a sign-in lasts as long as the IdP's SSO session (`offline_access` would be
  an org decision).

## Known limitations & follow-ups

- Same-second edits on the server that keep the file's size are not detected (ETag = mtime + size, Phase 09
  decision 2).
- The PowerShell launcher has not been run (Windows with Docker Desktop); managed settings have not been tried with a
  real Group Policy or `/etc/qe-workspace/policy.json` on a test machine.
- Theia's command palette does not list the Markdown plugin's `when`-scoped commands (its key binding works).
- Jump hosts (`ProxyJump`) are listed but refused: Phase 19.
- A desktop sign-in through the system browser cannot run in CI; its end-to-end evidence is a scripted run against the
  dev stack (P10.4).
- The 30-minute end of detached terminals is proven by unit tests (fake timers, Theia's stream per attached page);
  no E2E waits 30 minutes. A user who leaves a terminal running while no page is open for longer loses that shell.

## Decision

- [x] **10a PASS** — 2026-10-30: embedded broker, personal targets, credentials, host keys and local web meet the
      exit criteria on Linux (WSL) and Windows; the conflict defect above is fixed and proven in hosted mode.
- [x] **10b CONDITIONAL** — 2026-10-30: sign-in, managed settings and parity are done; conditions:
  1. D15 — signing certificates, then signed and notarized installers from the `desktop` workflow (owner: project
     owner, with the organisation's PKI team).
  2. D16 — package identity (maintainer address, homepage, app id).
  3. D17 — distribution and update channel.
  4. A green manual or nightly `desktop` run on Windows and macOS (parity-desktop included) after the push.
  5. D9 — hosted webview domain, to lift the hosted webview `fixme` (Phase 16 at the latest).
- [ ] FAIL
