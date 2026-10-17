# Phase Gate — Phase 02: Theia Product Shell (Browser and Desktop)

**Date:** 2026-10-17 · **Branch/PRs:** `claude/gallant-goldberg-v788zv` (PR to be opened) · **Reviewers:** @Barathparthi
(plan approved 2026-10-17 with: pinned + hashed plugins, no in-IDE marketplace, no Electron rebuild)

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_02_THEIA_PRODUCT_SHELL.md`.
Decisions: [ADR-012](../../05_ADR/ADRS.md).

## Deliverables

| Deliverable                                         | Status                                                                                                      | Evidence                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/ide-browser` (target browser)                 | done — Theia 1.76.0, 20 extensions + qe-core, binds 127.0.0.1                                               | `apps/ide-browser/package.json`                                      |
| `apps/ide-electron` (target electron)               | done — same extensions + `@theia/electron`; Electron 42.11.10; `electron-builder.yml` (installers Phase 10) | `apps/ide-electron/`                                                 |
| `extensions/qe-core`                                | done — commands, `QeEnvironment`, `qe.*` preferences, status bar, welcome page, About dialog, favicon       | `extensions/qe-core/src`, 59 unit tests                              |
| Built-in VS Code plugins from the internal Open VSX | **done with a stand-in** — 9 plugins pinned by SHA-256; registry URL is `open-vsx.org` until D7             | `config/vscode-plugins.json`, `scripts/plugins.ts` (47 tests)        |
| Workspace runtime dev image                         | done — digest-pinned, UID 1000, tini, `QE_MODE=hosted` default                                              | `images/workspace-runtime/Dockerfile`, `ide` workflow                |
| Smoke E2E: browser loads, Electron launches         | done — 8 browser + 3 Electron tests                                                                         | `tests/e2e/`, `ide` workflow                                         |
| `@theia/*` version sync check (P02.2)               | done — also checks extension sets, `@theia/vsx-registry`, Electron major                                    | `tests/lint/theia-versions.test.ts` (`npm run check:theia-versions`) |

## Exit criteria

| Criterion                                                                        | Result                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build -w @qe/ide-browser` and `-w @qe/ide-electron` succeed in CI       | Met — `ide` workflow builds both (run 3, green); the `verify` job (`npm run build`) builds both on ubuntu and windows on the PR                                                                                                      |
| Browser app opens; explorer, editor, terminal, search, git work on a sample repo | Met — smoke tests in CI with the real plugins: explorer, editor save, terminal, search, git (Source Control lists the changed file)                                                                                                  |
| Electron app opens with the same QE commands                                     | Met — Electron smoke tests: same four QE commands, `QE Desktop`, desktop-only setting                                                                                                                                                |
| Extensions load only from the internal registry (verified by network log)        | **Met for what exists**: the IDE has no marketplace and its page talks only to its own origin (smoke test); plugins come only from `QE_VSX_URL`, hash-pinned. The internal mirror itself is org decision D7 (stand-in: open-vsx.org) |
| Runtime dev image builds and runs as UID 1000                                    | Met — built in CI: `uid=1000(qe)`, HTTP 200, application files not writable, 9 plugins deployed, exit 78 without configuration                                                                                                       |

## Validation (real output, trimmed)

Local (this container, Node 24.22.0, Linux):

```text
$ npm run verify
> eslint . --max-warnings=0
All matched files use Prettier code style!
 Test Files  24 passed (24)
      Tests  400 passed (400)
[build/browser] Finished with 0 errors …   (ide-browser)
[build/browser] Finished with 0 errors …   (ide-electron; plus [build/node], [build/electron])

$ npm run test:unit -- --coverage            # All files: 90.06 % statements, 92.68 % branches, 81.08 % functions

$ CHROMIUM_PATH=/opt/pw-browsers/chromium xvfb-run -a npx playwright test
  8 passed, 1 skipped (git: no plugins here — Open VSX is not reachable from this container)

$ QE_MODE=hosted node apps/ide-browser/lib/backend/main.js /tmp --port=3102
QE Workspace cannot start. Invalid QE Workspace environment: QE_CONTROL_PLANE_URL is required in hosted mode; QE_WORKSPACE_ID is required in hosted mode
exit=78
```

GitHub Actions, workflow `ide` run 3 (head `b2b7281`) and `vscode-plugins` run 3:

```text
smoke (browser + Electron)
  ✓  [browser]  is branded QE Workspace and offers the QE commands
  ✓  [browser]  offers the qe.* settings, without the desktop-only telemetry switch
  ✓  [browser]  explorer lists the project files
  ✓  [browser]  editor saves changes to disk
  ✓  [browser]  terminal runs a shell in the project folder
  ✓  [browser]  search finds text across the project
  ✓  [browser]  git (vscode.git plugin) lists the changed file in Source Control
  ✓  [browser]  talks only to its own origin
  ✓  [electron] desktop app is branded and runs in desktop mode
  ✓  [electron] desktop app offers the same QE commands as the browser app
  ✓  [electron] desktop app adds the desktop-only telemetry setting, off by default
  11 passed (1.7m)

runtime image
GET / -> HTTP 200
uid=1000(qe) gid=1000(qe) groups=1000(qe)
touch: cannot touch '/opt/qe-workspace/probe': Permission denied
core:Stopwatch INFO Deploy batch of 9 accepted plugins
QE Workspace cannot start. Invalid QE Workspace environment: QE_CONTROL_PLANE_URL is required in hosted mode; …
exit code: 78
QE Workspace cannot start. Invalid QE Workspace environment: QE_MODE desktop is only valid in the desktop app
exit code (QE_MODE=desktop): 78
qews/runtime   ci   3fbd83cc9fe1   781MB

vscode-plugins: lock printed the nine hashes; download verified and unpacked all nine
```

## Security review

- **Threats touched**: T19 malicious VS Code extension (no marketplace; allowlisted, hash-pinned plugins; the
  extractor refuses traversal, symlinks, encryption, ZIP64 and oversized archives), T20 supply chain (base
  images by digest, exact `@theia/*` pins with a drift test, install scripts approved per package, Electron
  raised to 42.11.10 for four high-severity advisories), T15 container escape (non-root UID 1000, root-owned
  application files), T17 secret leakage (configuration errors name the variable, never its value — canary test).
- **Controls added**: fail-closed `QE_*` parsing (exit 78; `desktop` not settable in the browser app; workspace
  id only in hosted mode; control-plane URL https or loopback http, no credentials/query); the runtime image
  defaults to hosted so a misconfigured pod does not start; the mode is never read from the URL; Workspace Trust
  enabled; https-only documentation link.
- **Negative tests**: invalid mode, desktop mode in the browser app, hosted without URL/id, workspace id outside
  hosted mode, non-UUID id, eight bad control-plane URLs, value echo canary; plugin manifest/registry/redirect/
  size/timeout/hash-mismatch cases; five path-traversal names, symlink, encrypted, unsupported compression, CRC
  and limit cases for the extractor; version-drift, range, missing-extension, marketplace and Electron-major cases;
  the image refuses to start without configuration (CI).
- **Self-review findings fixed in this phase**: runtime image defaulted to local web when `QE_MODE` was unset
  (now hosted); startup on bad configuration dumped the minified bundle line (now one line, exit 78); a status bar
  contribution awaited RPC inside `onStart`, which Theia awaits before revealing the shell.

## Operational review

- Metrics / spans / logs: none added (Phase 13). Startup refuses bad configuration with exit code 78 (EX_CONFIG),
  so Kubernetes events show a configuration error rather than a crash loop of unknown cause.
- Audit events: none in this phase (no privileged actions).
- Alerts & runbooks: none yet; the image's `docker run` usage and the 127.0.0.1-only rule are in the Dockerfile.

## Parity (browser / local web / desktop)

- Same 20 Theia extensions and qe-core in both apps (enforced by the version test). Smoke tests show the same QE
  commands and welcome links in both; the mode differs as designed (`QE Local` in the browser app, `QE Desktop`
  in Electron); `qe.telemetry.enabled` exists only on the desktop. Hosted mode is exercised only by configuration
  parsing until Phase 05 runs the image behind the gateway. Electron was tested on Linux only; Windows and macOS
  move to Phase 10.

## Known limitations & follow-ups

- **D7**: no internal Open VSX mirror yet; plugin hashes are trust-on-first-use from open-vsx.org. Re-pin from the
  mirror with `node scripts/plugins.ts lock` once it exists.
- The IDE has no login of its own; the development image must be published on 127.0.0.1 only. Local web token
  (09 §5) is Phase 10, the hosted gateway and NetworkPolicy Phase 05.
- Theia still loads plugins a user places in `~/.theia/plugins`; in a user-controlled runtime (P9) that is the
  user's own code, but the hosted threat model should confirm it (Phase 14).
- **D14 / R19**: Theia AI core and MCP come with `@theia/plugin-ext`; no LLM provider is bundled.
- **D13**: the Documentation link points to the repository's user guide until the org names a location.
- electron-builder is configured but not installed; installers, signing and notarisation are Phase 10.
- The runtime image is 781 MB and contains the pruned workspace; slimming and hardening are Phase 05.
- This container cannot reach Open VSX or the Debian mirrors, so plugin hashes and the image build were verified on
  GitHub's runners; locally the built app ran as UID 1000 from a read-only mount.

## Decision

- [ ] PASS
- [x] **CONDITIONAL** (proposed 2026-10-17; the reviewer confirms or changes it in the PR review). Every exit
      criterion is met except that the "internal registry" is a stand-in. Condition: org decision **D7** names the
      Open VSX mirror; set `QE_VSX_URL` in CI and the image build and re-pin the plugin hashes from it. Owner:
      project owner with the platform team. Due: before Phase 05 deploys hosted runtimes.
- [ ] FAIL
