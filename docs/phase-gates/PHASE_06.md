# Phase Gate — Phase 06: Integrated Terminal Hardening

**Date:** 2026-10-19 · **Branch:** `phase-06-terminal` (local; owner pushes and merges) · **Reviewers:** @Barathparthi

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_06_INTEGRATED_TERMINAL_HARDENING.md`.

The local terminal is Theia's own (xterm.js + node-pty); this phase adds QE policy on top and proves the behaviour
in a real browser. Theia 1.76 already validates terminal requests (the shell must be an executable file, sizes
1–500, a real working directory) and kills the PTY when a terminal closes.

## Deliverables

| Deliverable                              | Status                                                                                                                                                                                                                                                   | Evidence                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| E2E checks first (§6.1)                  | done — real PTY (`isatty`), resize reaches the shell (`stty size` shrinks with the widget), Ctrl+C interrupts within seconds and the shell stays usable, 200,000-line flood then still responsive, UTF-8 round trip; cwd = project (existing smoke test) | `tests/e2e/terminal.browser.spec.ts` (CI `smoke` job)   |
| Shell allowlist (§6.2)                   | done — hosted and local web: `/bin/bash`, `/bin/sh`, `/bin/zsh` (and `/usr/bin/…`), overridable with `QE_TERMINAL_SHELLS`; another shell falls back to the default and loses its arguments; desktop unrestricted (the user's own machine)                | `qe-terminal-policy.ts`, unit tests                     |
| Terminal environment                     | done — `TERM=xterm-256color` on every terminal; `LANG=C.UTF-8` when the runtime has none; runtime image sets `LANG`/`LC_ALL=C.UTF-8`                                                                                                                     | policy + Dockerfile; E2E checks `$TERM`                 |
| Limits (§6.3)                            | done — at most 10 open terminals per IDE backend (`QE_MAX_TERMINALS`, 1–100; desktop 50), reserved before creation so parallel requests cannot overshoot, released on exit/close; scrollback default 10,000 lines                                        | `enforceTerminalPolicy`, app `package.json` preferences |
| Applied without replacing Theia's server | done — an Inversify activation hook decorates Theia's `IShellTerminalServer` singleton in both backends (browser and Electron), so Theia's client wiring stays intact                                                                                    | `bindQeTerminalPolicy`, container test                  |
| Process cleanup (§6.4)                   | Theia: PTY killed on terminal close; runtime: `tini` as PID 1 reaps zombies (Phase 02/05)                                                                                                                                                                | —                                                       |

## Validation (real output, trimmed)

Local: Windows 11, Node 24.22.0, no Docker, no Visual Studio Build Tools (Theia apps cannot be built here).

```text
$ npm run typecheck        → exit 0
$ npm run lint             → 0 problems
$ npx vitest run --project unit extensions/qe-core
      Tests  79 passed (79)      (12 new: policy, limits, parallel requests, failed create, Inversify decoration)
```

Not run locally: `tests/e2e/terminal.browser.spec.ts` (needs the built browser IDE). It runs in the `ide` workflow's
`smoke` job; record the result here.

## Security review

- **Threats touched**: T16 resource exhaustion (terminal limit, scrollback cap), T11/T9 (a frontend cannot pick an
  arbitrary binary as its "shell" in hosted/local web — e.g. `nc -l` or an interpreter with arguments).
- **Negative tests**: shells outside the allowlist, unsafe allowlist entries (`bash`, `/tmp/../bin/sh`), invalid
  limits, over-limit requests (sequential and parallel), failed creates releasing their slot, exit + close
  releasing only once; warnings never echo the refused shell path.

## Deviations from the guide (recorded)

- Terminal metrics (§6.5) move to Phase 13 with the telemetry package; Theia's own logs cover terminal errors now.
- Fork-bomb and output-flood checks _inside a workspace container_ (§ Tests) need Docker: they join the M1
  end-to-end run. The PIDs limit itself is configured and unit-tested in Phase 05.
- A one-line startup banner (§6.2) is not added: it would print on every terminal and add noise to every command
  transcript; workspace name and image version are in the status bar and About dialog.
- `.vscode/tasks.json` (§6.6) works through Theia's built-in task support; template tasks come with the QE runner
  (Phase 11).

## Known limitations & follow-ups

- Run `smoke` in CI and paste the result above (browser terminal suite + existing smoke tests).
- With Docker: fork bomb, flood and reconnect checks against a real workspace container (M1 run).

## Decision

- [ ] PASS
- [x] CONDITIONAL — pending the CI `smoke` run
- [ ] FAIL
