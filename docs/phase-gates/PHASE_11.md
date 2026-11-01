# Phase Gate — Phase 11: QE Test Runner and Reports

**Date:** 2026-11-01 · **Branch:** `phase-11-qe-runner` (stacked on `phase-10-local-desktop`; owner opens the PR) ·
**Reviewers:** @Barathparthi

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_11_QE_TEST_RUNNER_AND_REPORTS.md`. Prompts:
`03_PROMPTS/PHASE_11_PROMPTS.md` (P11.1–P11.6). Decision: ADR-014 (`packages/runner`: adapters that build argv, one
set of value checks, a streaming JUnit reader on `saxes`).

Plan decisions approved before implementation: (1) pytest comes from the distributions' packages in the runtime and
lab images; (2) a run's files stay where it ran (`.qe-runs/<runId>/`), the control plane keeps the record, counts,
failures and each artifact's sha256; (3) remote runs on personal hosts too, through the embedded broker; (4) `saxes`
for JUnit XML (no DTD, no entities); (5) local web and desktop keep their history with the project; (6) contract
addition `POST /test-runs/{id}/result`; (7) signed artifact download deferred to object storage (D18); reports of
remote runs stay on the target; (8) Maven only where a test container or the user's machine provides it (D19).
Owner's decisions during the phase: an exec session needs the lab role's `remote:connect` and the policy's `exec`
capability ("per policy", 07_SECURITY 4.2), as `file_write` in Phase 09; a terminal no page has been attached to for
30 minutes is ended (carried over from Phase 10).

## Deliverables

| Deliverable                  | Status                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Run model and adapters       | done — run types, selectors (all, file, node id, marker / Maven groups), pytest and Maven Surefire adapters that build argv only; every user value checked (paths inside the project, no shell syntax or leading dash, node ids by PHASE_11's pattern, Java names, UUID run ids, environment denylist for loader, shell and start-up variables) | `packages/runner/src/`, ADR-014                                                |
| JUnit reader                 | done — streaming, chunked; counts every case, keeps at most 10,000 with message and stack capped at 64 KB (`truncated` says so); depth ≤ 64; malformed XML refused; no entity expansion; failing line from pytest's frame or the class's JVM frame; a 50 MB report read in chunks                                                               | `packages/runner/src/junit.ts`, `junit.test.ts`                                |
| Local runner                 | done — `spawn(file, args, { shell: false })` in its own process group; Cancel = SIGINT, SIGKILL after 10 s; leftovers ended when the run ends; ≤ 2 concurrent runs, 60 min limit; allowlisted environment; the project's `.venv`; live output to every page, last 5 MB in memory, all of it in `output.log`                                     | `extensions/qe-runner/src/node/runner-service.ts`                              |
| Results and artifacts        | done — report read when the run ends; `junit_xml`, `html_report` (when `pytest-html` is installed) and `log` artifacts with sha256; `run.json` as local history                                                                                                                                                                                 | `run-results.ts`                                                               |
| Control-plane records        | done — create (`qe_test:execute`), result (`qe_test:execute`), list and get (`workspace:read`), cancel (`qe_test:cancel`); invisible runs 404; migration 0005 (duration, failures, truncated, indexes); audit events for start, cancel and result                                                                                               | `apps/control-plane/src/routes/test-runs.ts`, `0005_test_run_results.sql`      |
| Remote runs (managed)        | done — `POST /targets/{id}/test-runs` records the run and its exec session in one transaction; the broker builds the command from the ticket's framework and selector, quoted by `shellQuote` only; results from the broker only (internal route); cancel closes the session and stops the run on the target, INT then KILL; migration 0006     | `broker-core/src/remote-exec.ts`, `remote-run.ts`, `0006_remote_test_runs.sql` |
| Remote runs (personal hosts) | done — same `runRemoteTests` in the embedded broker: deny list, `known_hosts` and trust on first use, agent and key files; local audit log                                                                                                                                                                                                      | `qe-remote/src/node/embedded-broker.ts`                                        |
| QE Tests panel               | done — test tree from discovery, Run all / file / test, Cancel, live output, counts, failures that open the test at its line (locally or in the remote folder), run files, earlier runs, **Run on** (this project or a remote system); `QE: Run Tests`, `QE: Show Tests`                                                                        | `extensions/qe-runner/src/browser/`                                            |
| Policy                       | done — exec per policy: `remote:connect` + the policy's `exec` capability; the generic sessions route no longer opens exec sessions                                                                                                                                                                                                             | `packages/policy`, `d96f58e`, `f76ee50`                                        |
| Images and samples           | done — `python3-pytest` 7.2.1 in the runtime image, `py3-pytest` 8.3.5 in the OpenSSH lab image; sample pytest project (3 pass, 1 fails on line 21, 1 skipped) and sample Maven project (JUnit 5.11.4, Surefire 3.5.2)                                                                                                                          | `tests/fixtures/`, `images/workspace-runtime/Dockerfile`                       |

## Validation (real output, trimmed)

Windows (no Docker), commit `2b13ed8`, then `4ab838d` for the two hardened tests:

```text
$ npm run typecheck        → exit 0
$ npm run lint             → exit 0
$ npm run format:check     → All matched files use Prettier code style!
$ npx vitest run --project unit           (2b13ed8, while the WSL build ran)
 Test Files  2 failed | 72 passed (74)
      Tests  2 failed | 1712 passed | 4 skipped (1718)
$ npx vitest run --project unit <the two files>   (4ab838d)
 Test Files  2 passed (2)
      Tests  40 passed | 1 skipped (41)
```

WSL Ubuntu, commit `2b13ed8`: control plane and broker rebuilt and restarted (migrations 0005 and 0006 applied), lab
policy with `exec` (v10), runtime image `a9ea627db394` built from it (third attempt: the proxy dropped two downloads,
`ETIMEDOUT`), workspace restarted on it (`pytest 7.2.1`):

```text
$ npx playwright test --project hosted              3 passed (57.0s) — again: 3 passed (58.2s)
$ npx playwright test --project parity-hosted       5 passed, 1 skipped, 1 failed (1.8m)   ← harness, see Defects; 2 later scenarios did not run
$ npx playwright test --project browser             23 passed (6.3m)
$ npx playwright test --project local-web-security  6 passed (3.0s)
$ npx playwright test --project electron            4 passed (22.0s)
$ npx playwright test --project parity-local-web    10 passed (2.6m)
$ xvfb-run -a npx playwright test --project parity-desktop
                                                    9 passed (3.2m)
$ npx vitest run --project integration              Test Files 16 passed | 1 skipped (17)   Tests 154 passed | 1 skipped (155)
$ npx vitest run --project unit                     Test Files 74 passed (74)               Tests 1716 passed | 2 skipped (1718)
```

After the harness fix, commit `b6c86b4`, same stack and image:

```text
$ npx playwright test --project parity-hosted       8 passed, 1 skipped (3.3m) — again: 8 passed, 1 skipped (2.5m)
$ npx vitest run --project integration --reporter=verbose
 ↓ maven.int.test.ts > local test runs with Maven > runs the sample project …   (the one skipped file)
```

Skipped: the hosted webview scenario (`fixme`, D9); the real-Maven integration run (opt-in, `QE_TEST_MAVEN=1` with
`mvn` installed: Maven Central is not an approved build source, D12/D19); the two Windows-only `reg.exe` unit tests (on Linux).

## Defects found during the phase and its review

- **A remote run's reports were read outside the folder's confinement** (`2b13ed8`, threat T10). After a remote run
  the broker read the JUnit report, Surefire's reports, the pid file, the venv and the Maven wrapper with raw SFTP
  paths, so a link planted in `.qe-runs` or `target` could make it read a file outside the target's folder. Nothing
  the account could not read by running tests anyway, but every other remote file operation is confined. All of them
  now go through `createRemoteFileSystem`, read-only, with the report limits: realpath inside the folder, links out
  never followed. Regression test with planted links for pytest and Maven.
- **Lab users could never run remote tests** (`f76ee50`, owner's decision). Exec required `remote:execute`, which
  only `qe.admin` holds, while 07_SECURITY 4.2 grants lab users exec "per policy". Now `remote:connect` plus the
  policy's `exec` capability, as `file_write` in Phase 09.
- **Remote cancel did not stop the run on Debian and Ubuntu targets** (`ec6a6d3`, before its commit). Their `sh` is
  dash, which refuses `kill -KILL -- -PGID` ("Illegal number"); the cancel command now uses `kill -SIG -PGID`, tested
  against a real `sh` and an OpenSSH target.
- **Managed settings could fail to load on a busy machine** (`4ab838d`). `reg.exe` had 5 s; under load (a build
  running in WSL) the read timed out, which stops the desktop app at startup. Now 15 s. The runner's unit tests
  waited 1 s for a spawned process and failed on the same loaded machine; they now wait up to 15 s, as their `done()`
  already did. No assertion changed.
- **Parity harness: a fresh hosted project had no `tests/` folder** (`b6c86b4`). The new "runs the pytest sample"
  scenario wrote `tests/conftest.py` with `cat >` in the workspace container and failed with "writing into the
  workspace failed" before the panel was used; it had passed earlier only because an older project had the folder.
  Both project writers now create the file's folder.
- **The runtime image build gave up on proxy timeouts** (`dc812cc`). npm now retries a download 6 times, 20–120 s
  apart, in the build stage only.

## Security review

- **Threats**: command injection through selectors, paths, markers, Maven names or environment (T11) — argv only
  locally (`shell: false`); on targets one quoting helper (`shellQuote`: every element in single quotes, NUL
  refused) and command lines built only from fixed text and quoted values; every value checked by the adapters at the
  RPC boundary and again in the broker; the control plane sends the broker a framework and a selector, never a
  command line. Report parsing (XML bombs, entity expansion, huge or deep files) — `saxes` without DTD, depth and size
  limits, 50 MB remote cap, chunked reads. Reading outside the folder (T10) — above. Environment smuggling
  (`LD_PRELOAD`, `PYTHONSTARTUP`, `NODE_OPTIONS`, …) — denylist; remote runs take no extra environment (it would be
  stored with the run). Forged results — results of remote runs come only from the broker's internal route, from the
  session that carries the run. Runaway runs — process groups, SIGINT then SIGKILL, leftovers ended, time limit,
  concurrency limit, idle and expiry of the exec session.
- **Controls added**: `qe_test:execute` / `qe_test:cancel` / `workspace:read` on every route (`config.permission`),
  invisible runs and targets 404, audit events for start, cancel and result; exec sessions only for test runs and only
  under a policy with `exec`; Maven refused on Windows desktop (`mvn.cmd` starts only through a shell, rule 6).
- **Negative tests**: hostile arguments round-tripped through a real `sh`; a folder whose name is an injection attempt;
  leading dashes, `..`, absolute paths, shell metacharacters and option-like Maven values refused; denied environment
  variables; malformed, deep and oversized XML; planted links in `.qe-runs` and `target`; exec refused for a policy
  without `exec`; results from a non-broker caller refused; another user's run 404.
- **Logs**: no command line, environment or output is logged; the broker logs only a run's id when it cannot report it.

## Operational review

- Audit: `QE_TEST_STARTED`, `QE_TEST_CANCELLED`, `QE_TEST_FINISHED` on the control plane, with counts only (no paths
  or test names, tested); started and
  finished personal-host runs in the local audit log (`~/.qe-workspace`).
- Limits are configuration: `QE_RUNNER_MAX_CONCURRENT` (2), `QE_RUNNER_TIMEOUT_MIN` (60).
- Metrics, alerts and runbooks: Phase 13.

## Parity (browser / local web / desktop) — milestone M3

"Runs the pytest sample from the QE Tests panel and records the result" is one scenario in all three parity projects,
each checked outside the IDE (the record the backend saved: total 5, passed 3, failed 1, skipped 1). Local web 10/10
and desktop 9/9 on `2b13ed8`; hosted on `b6c86b4` after the harness fix (Validation). With the same sample project
opened in hosted web and on the desktop, the same run gives the same results and report: **M3 is met**.

## Deviations from the guide (recorded)

- No HTML report from the images: neither Debian nor Alpine packages `pytest-html`, and PyPI is not an approved build
  source (D12). The adapter writes one only where a project installs it.
- Local web and desktop history is the project's `run.json` files, not a database.
- Remote runs take no extra environment variables (they would be stored with the run).
- Exec is granted per policy (owner's decision), not by `remote:execute`.
- Maven is refused on the Windows desktop app (rule 6); Maven is not in the runtime image (D19). `qe.runner.junitGlob`
  is defined but not applied: each adapter knows where its framework writes reports.
- Real Maven runs only in the opt-in integration test (`QE_TEST_MAVEN=1`); a remote Maven run records counts and
  failures only (its reports stay on the target).
- Signed artifact download is deferred to object storage (D18); reports of remote runs stay on the target.
- In hosted mode the IDE backend in the user's workspace reports a local run's result; the control plane trusts that
  record as it trusts the workspace (the user's own runtime). Remote results come from the broker only.

## Known limitations & follow-ups

- No E2E or parity scenario runs a test **on a remote system** from the panel; integration tests cover it against a
  real OpenSSH target (run, counts, cancel mid-run, an injection-named folder, confinement). Add one to the parity
  suite in Phase 14.
- The idle timeout of the exec session applies to a silent remote run: a test that prints nothing for longer than the
  policy's idle time is ended.
- Maven discovery lists test classes by Surefire's default naming; methods appear after a run.
- The first image build attempt failed without its cause kept (its log was overwritten by the retry).

## Decision

- [x] **PASS** — 2026-11-01: local and remote test runs, results, artifacts, cancel and the QE Tests panel meet the
      exit criteria in all three modes; injection and confinement tests are green; M3 is met. Open org decisions D18
      (artifact storage) and D19 (Maven source) do not block it: their stop-gaps are recorded above.
- [ ] CONDITIONAL
- [ ] FAIL
