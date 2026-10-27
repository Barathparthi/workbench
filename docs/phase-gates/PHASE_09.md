# Phase Gate — Phase 09: Remote Filesystem

**Date:** 2026-10-27 · **Branch:** `phase-09-remote-fs` (from `main` after PR #18; owner opens the PR) ·
**Reviewers:** @Barathparthi

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_09_REMOTE_FILESYSTEM.md`. Prompts:
`03_PROMPTS/PHASE_09_PROMPTS.md` (P09.1–P09.5). Decisions: ADR-006 option B (Theia frontend extension, provider
registered through a dependency-free `FileServiceContribution`, spike S3).

Plan decisions approved before implementation (2026-10-27): (1) changes need the policy's `file_write` capability,
granted per policy as in 07_SECURITY §4.2; (2) ETag = mtime-size, same-second edits of equal size not detected;
(3) one broker instance (multi-broker routing in Phase 16); (4) Windows targets out of scope; (5) the hosted E2E runs
locally, CI in Phase 15; (6) save latency measured on the local Docker network and reported as such.

## Deliverables

| Deliverable                   | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Path confinement (two layers) | done — lexical `confine()` (NUL, absolute, drive letters, > 4096 chars, escape after normalization; result never contains `..`) and `PathGuard` with the server's realpath: `follow` for read/list/stat, `entry` (parent only) for create/rename/delete, so a link is acted on, never followed; real root cached per session, every other path asked again per call                                                                                                                                                                       | `broker-core/src/confine.ts`, 100 % lines/branches                               |
| SFTP operations               | done — stat, list (5,000 entries, `truncated`, dirs first, temp files hidden), read (10 MB, size from the open handle, one byte past the limit refused), write (10 MB, ETag `ifMatch` → 409, atomic temp file + `posix-rename`, permissions kept minus setuid/setgid), mkdir (recursive), rename (overwrite, no move into itself), delete (recursive with 10,000-entry / depth-32 caps checked before anything is removed, links unlinked, never followed); 15 s per operation; SFTP status codes mapped to API codes with fixed messages | `broker-core/src/remote-fs.ts`, `sftp.ts`                                        |
| Contracts                     | done — request/result schemas, limits, ETag format; `BrokerFsRequest`; audit metadata `REMOTE_FILE_WRITE/DELETE/RENAME` (relative paths and sizes only)                                                                                                                                                                                                                                                                                                                                                                                   | `contracts/src/remote-files.ts`, `audit.ts`                                      |
| Control-plane API             | done — `POST /api/v1/sessions/{id}/fs/{op}` (7 routes, OpenAPI): owner only (others, admins included, 404), files sessions only, 410 when closed/expired/revoked, snapshot rebuilt per call (a disabled target or changed policy ends the session and drops it on the broker), `file_write` checked, changes audited success/failure/denied, read escapes audited as `ACCESS_DENIED`                                                                                                                                                      | `control-plane/src/remote-file-service.ts`, `routes/remote-files.ts`             |
| Broker files-sessions         | done — internal `POST /internal/v1/sessions/{id}/fs/{op}` (service token); one SSH + SFTP connection per session opened on first use with the same pre-connect checks as terminals (now one shared function); 4 operations at a time; closed when idle (never during an operation), at expiry, on revocation or shutdown; reported to the control plane                                                                                                                                                                                   | `connection-broker/src/files-sessions.ts`, `server.ts`                           |
| IDE: `qe-ssh://` provider     | done — `qe-ssh://{targetId}/{path}`; one files session per target, replaced once on 410, resumed after a reload (tab `sessionStorage`); saves carry the ETag of the stat Theia makes just before writing; errors as actionable messages                                                                                                                                                                                                                                                                                                   | `qe-remote/src/browser/qe-ssh-file-system-provider.ts`, `common/remote-files.ts` |
| IDE: Open Remote Folder       | done — adds the target's folder as a workspace root after checking it can be read; `[target]` label and remote icon; `qe-ssh://` roots kept intact in the workspace file (Theia 1.76 stores file roots only)                                                                                                                                                                                                                                                                                                                              | `qe-remote-contribution.ts`, `qe-remote-files.ts`, `qe-workspace-service.ts`     |
| Watching                      | done — polling: files the IDE read (open editors) every 5 s, folders it listed (expanded) every 10 s, 20 most recent of each, under a covering watch; paused while the page is hidden or the user inactive 10 min                                                                                                                                                                                                                                                                                                                         | `qe-remote/src/browser/remote-watcher.ts`                                        |
| Conflict handling             | done — a change on the server reloads a clean editor; a dirty one gets Theia's "changed on the file system" dialog on save (No keeps the server's version, Yes overwrites); the server's `ifMatch` closes the race between Theia's check and the write                                                                                                                                                                                                                                                                                    | hosted E2E                                                                       |

Found and fixed along the way (each with a test, see Validation): the workspace file lost `qe-ssh://` roots; ~45 ms of
Nagle/delayed-ACK per SFTP round trip; sessions of a restarted broker counted against limits forever (and the
restart sweep was lost when the broker started first); a new files session per page load; vague messages for the
session and rate limits; ssh2's generator yielding unparseable test keys; a flaky terminal smoke test.

## Validation (real output, trimmed)

Windows (no Docker), final commit `76484ae`:

```text
$ npm run typecheck        → exit 0
$ npm run lint             → exit 0
$ npm run format:check     → All matched files use Prettier code style!
$ npx vitest run --project unit
 Test Files  50 passed (50)
      Tests  1371 passed (1371)
broker-core coverage (unit only): lines 97.29 %, branches 92.49 %, functions 95.51 %
  confine.ts 100 % / 100 % · remote-fs.ts 98.5 % / 95.55 % · sftp.ts 97.95 % / 86.53 %
```

WSL Ubuntu, Docker Engine 29.9.2, Node 24.22.0:

```text
$ npm run test:integration
 ✓ packages/broker-core/src/__tests__/remote-fs.int.test.ts (7 tests)     real OpenSSH: CRUD, atomic save + mode,
                                                                          409 after a side-channel edit, symlink out of
                                                                          the root, directory swapped for a symlink,
                                                                          11 MB → 413, 10 MB round trip
 ✓ tests/security/traversal.int.test.ts (24 tests)                       every corpus path × 9 operations, as an
                                                                          account that CAN write the canary folders
 ✓ apps/control-plane/src/__tests__/oidc-keycloak.int.test.ts (3 tests)
 Test Files  10 passed (10)
      Tests  121 passed (121)

$ npx playwright test --project browser             13 passed (2.9m)
$ npx playwright test --project hosted              (IDE /w/{id}/ → control plane → broker → lab OpenSSH)
remote save ms: 142, 123, 130, 131, 123, 137, 115, 110, 116, 120 → p95 142
  ✓ opens the remote folder, edits and saves a file, and saves stay under 1 s (p95)
  ✓ reopening shows what was saved
  ✓ a change on the server reloads a clean editor; a conflicting save asks before overwriting
  3 passed (1.0m)
```

Save latency (Ctrl+S until the editor is clean, Playwright's polling included, so an upper bound) on the local Docker
network: p95 **142 ms** (target < 1 s). Per operation through control plane, broker and SFTP, 20 calls each:

|                                   | before `TCP_NODELAY` | after (p50 / p95) |
| --------------------------------- | -------------------- | ----------------- |
| stat                              | 102 ms               | 12 / 23 ms        |
| read                              | 277 ms               | 14 / 17 ms        |
| write                             | 329 ms               | 19 / 25 ms        |
| first operation (SSH + SFTP open) | 491 ms               | 281 ms            |

The traversal corpus (11_TESTING_STRATEGY §6) runs three ways: lexically, against the realpath guard and every
operation on an in-memory SFTP server (the server is never asked about a path outside the root), and against real
OpenSSH (nothing outside the root changes).

## Security review

- **Threats**: path traversal and symlink escape (two-layer confinement, re-checked per call, links never followed on
  mutation, corpus 100 % green); T8 / logging rule 4 (contents travel base64 only, never logged or audited; errors
  carry fixed messages; tests search the audit table and logs for a canary); IDOR (sessions are the owner's only,
  administrators included: reading someone's files is not session administration); policy drift (snapshot rebuilt per
  call); T16 (size, entry, depth, time and concurrency limits; per-user session cap shared with terminals).
- **Controls added**: `file_write` per policy, checked by the control plane and again by the broker from the snapshot;
  audit of every change (success/failure/denied) and of read-side escapes; setuid/setgid dropped on save; stale
  sessions of a restarted broker closed and audited; the broker opens no session until that sweep is done.
- **Negative tests**: traversal corpus ×3; symlink to a writable folder outside the root; symlink swap between calls;
  write/mkdir/rename/delete without `file_write` (403, audited, nothing reaches the broker); other user / admin → 404;
  closed, revoked and expired sessions → 410; policy change → `TARGET_NOT_ALLOWED`; 11 MB read → 413; NUL in a path
  audited without breaking the audit log; authorization matrix over the 7 new routes × 6 personas.
- **Residual races (documented)**: the remote account can swap a directory for a symlink between the check and the
  call, and another writer can change a file between the ETag check and the rename. The account's own Unix
  permissions stay the hard limit; confinement keeps the IDE inside the policy's root.

## Operational review

- Logs: request logs carry session id and operation only (no paths, no contents); broker warnings for failed opens,
  reports and the startup sweep.
- Audit events: `REMOTE_FILE_WRITE` (write, mkdir), `REMOTE_FILE_DELETE`, `REMOTE_FILE_RENAME`, `ACCESS_DENIED`
  (`PATH_OUTSIDE_ROOT` on reads), `SSH_SESSION_OPENED/CLOSED` for files sessions, `SSH_SESSION_CLOSED`
  (`broker_restarted`).
- Readiness: the broker reports `/readyz` 503 `starting` until the control plane has closed its previous run's
  sessions; it retries that call with backoff (1 s → 30 s).
- Metrics, alerts and runbooks: Phase 13.

## Parity (browser / local web / desktop)

- Browser (hosted): full feature, E2E above.
- Local web and desktop: remote folders need a control plane and, on desktop, the Electron-backend relay with desktop
  sign-in (Phase 10); "Open Remote Folder…" explains this instead of failing.

## Deviations from the guide (recorded)

- `remote:file_write` is granted per policy (`file_write` capability) rather than by role, as 07_SECURITY §4.2's
  "per policy" column says; the route asks for `remote:file_read`.
- Polling intervals are fixed (5 s / 10 s / 10 min away), not yet preferences.
- Files over 10 MB are refused with a clear message; there is no read-only preview for large or binary files.
- Theia's conflict dialog offers Yes/No (overwrite or keep); there is no Compare action yet.
- A files session gets a ticket at open like any session, but never redeems it (file calls authenticate with the
  sign-in cookie and ownership); it expires unused.
- Atomic saves create a new file: ownership becomes the remote account's and hard links are broken (common to atomic
  savers).

## Known limitations & follow-ups

- Sessions of a broker replica that never comes back (new instance id) are not swept: Phase 13 reconciler.
- ETag has whole-second resolution: an edit within the same second that keeps the size is not detected.
- An operation that times out (15 s) may still complete on the server.
- Hosted E2E is not in CI (needs the full stack): Phase 15. The p95 was measured on the local Docker network, not a
  lab network.
- ssh2 1.17.0's `generateKeyPairSync('ed25519')` yields ~0.6 % keys its own parser rejects (tests now draw again);
  worth an upstream issue.
- The OpenSSH test image installs packages from `dl-cdn.alpinelinux.org` on every build; two runs stalled 240 s behind
  the proxy. Cache or pre-build the image (Phase 15).
- Windows OpenSSH targets: not in scope (decision 4).

## Decision

- [x] PASS — 2026-10-27: exit criteria met — M2 complete (remote terminal and remote file editing in the browser
      IDE), traversal/symlink suite 100 % green, remote save p95 142 ms. Owner to confirm the GitHub Actions run on the
      PR is green.
- [ ] CONDITIONAL
- [ ] FAIL
