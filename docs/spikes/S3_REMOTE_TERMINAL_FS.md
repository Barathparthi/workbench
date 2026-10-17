# Spike S3 — Remote terminal + remote files inside Theia

**Date:** 2026-10-17 · **Phase:** 00, step 0.6 · **Code:** [`spikes/s3-remote/`](../../spikes/s3-remote/) · **Decides:**
ADR-006 · **Informs:** `extensions/qe-remote` (Phases 08–10), session contract (`05_API_CONTRACTS.md`), ADR-005
webviews, risk R2 · **Environment:** Linux x64 container, Node 24.22.0, Theia 1.76.0 (plugin API 1.139.0),
Electron 42.8.1, Chromium (Playwright 1.63.0), `ssh2` 1.17.0, OpenSSH 9.6p1 target from S4

## Question

Which way of putting a remote (SSH) terminal and remote files into Theia meets P9 (the workspace runtime never
gets SSH reachability or credentials), works the same in the browser and in Electron, and survives Theia
upgrades?

- **A** — VS Code API plugin: `window.createTerminal({ pty })` + `workspace.registerFileSystemProvider`, shipped
  as a web extension (`browser` entry) so it runs in the frontend, not in the runtime's plugin host.
- **B** — Theia frontend extension: Theia's `TerminalWidget` in pseudo-terminal mode + a `FileSystemProvider`
  registered in the frontend `FileService` through a `FileServiceContribution`.
- **C** — standalone xterm.js widget (fallback).

## Setup

Both options implement the same feature against a stub of the contract's session API
([`broker-stub/server.mjs`](../../spikes/s3-remote/broker-stub/server.mjs)): `POST /api/v1/targets/{id}/sessions`
→ single-use 60 s ticket; `WS /api/v1/sessions/{id}/stream` with subprotocols `qews.v1` + `ticket.<b64url>`,
binary frames `0x00` input / `0x01` output, JSON `resize`; `POST /api/v1/sessions/{id}/fs/{op}` for
`stat|list|read|write|mkdir|delete|rename`, confined to the remote root. The stub reaches the S4 OpenSSH target
with `ssh2` (host key pinned, PTY, SFTP). Both options are loaded **side by side in the same apps** (one
browser app, one Electron app) and exercised by [`verify/check.mjs`](../../spikes/s3-remote/verify/check.mjs),
which reads the evidence back from the remote host.

## Result

**Option B.** It passes everything in the browser and in Electron. Option A passes everything in the browser
but **cannot run in Theia's Electron app at all**, and there is no packaging of it that runs on the desktop
without breaking P9 in hosted mode (finding 1).

| Check (evidence read back from the remote host) | Browser A | Browser B | Electron A | Electron B |
| --- | --- | --- | --- | --- |
| Terminal: `echo REMOTE_X_$(id -un)_$(stty size)` → marker file | ✔ `REMOTE_A_qeuser_14x129` | ✔ `REMOTE_B_qeuser_14x129` | ✘ never starts | ✔ `REMOTE_B_qeuser_8x79` |
| PTY size = the widget's real size | ✔ 14×129 | ✔ 14×129 | — | ✔ 8×79 (smaller window) |
| Ctrl+C interrupts remote `sleep 30` (`echo CTRLC_$?`) | ✔ `CTRLC_130` | ✔ `CTRLC_130` | — | ✔ `CTRLC_130` |
| Open `hello.txt` from the remote host, edit, Ctrl+S → content on the host | ✔ 0.4 s | ✔ 0.4 s | ✘ never starts | ✔ 0.4 s |
| Webview (A only): rendered in its own origin | ✔ `http://412923f3-….webview.localhost:3000`, path `/webview/fake.html` | n/a | ✘ | n/a |
| Frontend plugin worker running | ✔ `plugin-worker.js` | | ✘ none | |

Raw output of the final runs: [`s3/results-browser.json`](s3/results-browser.json),
[`s3/results-electron.json`](s3/results-electron.json); screenshots in [`docs/spikes/s3/`](s3/)
(`run-browser-a.png`, `run-browser-b.png`, `run-browser-webview.png`, `run-electron-b.png`). The broker logged every browser session (both options) with
`Origin: http://localhost:3000`: the terminal and file traffic of **both** options left from the page, never from
the Theia backend.

## Findings

### 1. Theia never starts web extensions in Electron → option A has no desktop story

The Electron app lists option A's commands (contributions load) but executing them does nothing, and no plugin
worker exists. Theia 1.76 skips the frontend plugin host on Electron on purpose —
`@theia/plugin-ext/lib/hosted/common/hosted-plugin.js`:

```js
// do not start plugins for electron browser
if (host === PLUGIN_HOST_FRONTEND && environment.electron.is()) { continue; }
```

The ways around it all fail a requirement (from the source, not run):

- **Dual entry** (`browser` + `main`): a plugin with a `browser` entry is always assigned to the frontend host
  (`entryPoint.frontend ? PLUGIN_HOST_FRONTEND : plugin.host`), so on Electron it is skipped all the same.
- **Node-only build** (`main`): runs in the backend plugin host. On the desktop that is fine (the user's
  machine), but the same extension in the hosted browser IDE would run **inside the workspace runtime** — the P9
  violation the phase guide warns about. So A would need two builds and a per-mode packaging rule, plus a second
  transport implementation (Node) for the desktop.

### 2. Option B builds on the same seams as Theia's own VS Code API layer (R2)

Option B uses three Theia APIs: `TerminalService.newTerminal({ isPseudoTerminal: true })` +
`TerminalWidget.write/onData/onSizeChanged`, `FileServiceContribution`, and
`FileSystemProviderWithFileReadWriteCapability`. These are not public API, but Theia's VS Code compatibility
layer is built on exactly them (`plugin-ext/lib/main/browser/terminal-main.js` creates pseudo-terminals that way,
`file-system-main-impl.js` registers extension file systems in the `FileService`). They cannot change without
Theia changing its own VS Code support, which keeps the upgrade risk moderate. Keep the mitigation from R2: pin
Theia, keep `qe-remote` behind small adapters, and run an end-to-end check like `verify/check.mjs` on every
Theia upgrade (R13).

Option B also gives what A cannot: DI-bound clients per mode (`ConnectionClient`, as
`02_SOLUTION_ARCHITECTURE.md` §4.1 already plans), Theia's terminal features (tabs, find, links, preferences),
and no dependency on the web-extension host, which is the least mature part of Theia's plugin system.

### 3. Pitfalls met in option B (and their fixes)

- **DI cycle:** `FileService` collects `FileServiceContribution`s in its constructor. A contribution that also
  injects `TerminalService` (which needs `FileService`) makes the frontend fail at start ("construct
  FileServiceContribution synchronously but has asynchronous dependencies", then a stack overflow). Register the
  provider from a dependency-free contribution; put commands in a separate class.
- **Terminal size race:** the widget is fitted, and fires `onSizeChanged`, while the session is still being
  opened, so the PTY came up 24×80. Subscribe to `onSizeChanged` before `start()`, open the session with the
  current size and send one explicit `resize` once the stream is open.
- **Early keystrokes:** input sent before the SSH shell channel is ready was dropped. The stub queues frames
  until the channel opens; the real broker must do the same (or the client must wait for a `ready` message).

### 4. Desktop: the renderer has origin `file://`; route through the Electron backend

Theia's Electron frontend is loaded from `file:///…/lib/frontend/index.html`. Its `fetch` calls reached the stub
**without an `Origin` header**, and its WebSocket carried **`Origin: file://`**, which the contract's Origin
allowlist rejects (first Electron run: `ws reject 403 file://`). The stub was then changed to let `file://`
through so that the transport could be shown working, but a real broker must not: any local HTML file has the
same origin. Desktop credentials also belong in the main process (T22: tokens in `safeStorage`), not in the
renderer.

Recommendation for Phase 10: on the desktop, bind `ConnectionClient` to an implementation that relays over
Theia RPC to the Electron backend — the embedded broker for personal targets, and the hosted broker with the
user's Bearer token for managed targets (the flow `02_SOLUTION_ARCHITECTURE.md` §5.4 already draws). Option B's
widget and provider stay the same; only the bound client changes. Proposed contract addendum (Phase 08):
browser clients must send an allowlisted `Origin`; a request or WebSocket without `Origin` is accepted only with
Bearer authentication, never with the session cookie.

### 5. Save conflicts: Theia checks them, but SFTP times are coarse

When the check script rewrote `hello.txt` under an editor that was still open from an earlier group, Theia's save
showed "The file 'hello.txt' has been changed on the file system. Do you want to overwrite…?" — conflict
detection works through a custom provider. Theia derives the ETag from the provider's `stat`
(`mtime` + `size`) and compares it before writing. Two limits for Phase 09 (remote filesystem):

- SFTP v3 reports `mtime` in **whole seconds**, so a change in the same second that keeps the size is invisible;
  the contract's ETag (`mtime+size`) has the same blind spot. Accept and document it, or add a content hash for
  files under the read-size limit.
- Theia's check is client-side (stat, then write). To narrow the race, the broker's `write` should take
  `ifMatch` and re-check the ETag itself just before writing (`412` → Theia's overwrite dialog).

### 6. Ctrl+C needs no special message

xterm.js sends Ctrl+C as the byte `0x03` in the input stream; the remote PTY turns it into SIGINT (exit 130) in
both options. This matches S4 (SSH `signal` requests are ignored by OpenSSH); the contract's JSON `signal`
message is only needed for UI actions such as a "Stop" button, and the broker should map it to writing `\x03`.

### 7. Webviews confirmed (S2 follow-up)

Option A's webview rendered in its own origin, `{uuid}.webview.<host>` with the page path kept
(`/webview/fake.html`), as S2 predicted from the source. Opened through `http://127.0.0.1:3000` the webview stays
blank, because `{uuid}.webview.127.0.0.1` does not resolve: the IDE must be reached by a host name
(`localhost` in development; wildcard DNS + certificate in hosted, see S2/ADR-005). Webviews are not part of
the remote terminal/FS feature; this only confirms the hosting requirement.

### 8. Notes for end-to-end tests (Phase 02+)

- Clearing `localStorage` and reloading does not give a clean IDE: Theia stores the layout again on unload. Run
  **View: Reset Workbench Layout** (`reset.layout`), which clears it and reloads without storing.
- The plugin host requests an optional `package.nls.json` for each plugin; a 404 there is expected.

## Effort and decision matrix

Option A is 131 lines of plain JavaScript with no build step; option B is 241 lines of TypeScript in the normal
extension build. A needed nothing Theia-specific in the browser; B ran into the three pitfalls of finding 3,
each fixed in a few lines.

| Criterion | A — VS Code web extension | B — Theia frontend extension |
| --- | --- | --- |
| P9 in hosted mode | ✔ (runs in the page's worker) | ✔ (runs in the page) |
| Browser / Electron parity | ✘ not started in Electron; desktop needs a second, Node build | ✔ same code; only the bound client differs |
| Upgrade risk | Public API, but depends on the web-extension host | Internal API, but the same seams Theia's VS Code layer uses |
| Fit with the architecture (DI clients per mode, `qe-remote` extension) | Poor (plugin sandbox, no DI) | Direct |
| Effort | Smaller, no build — but a second build for the desktop | Larger, three Theia pitfalls (now known) |

**Option C** (standalone xterm.js widget) was not built: B already uses Theia's xterm-based terminal widget
without a backend process, which is what C would hand-roll, minus Theia's terminal features.

## Not covered (later phases)

Reconnect and resume after network loss, flow control/backpressure on fast output, large and binary files,
many concurrent sessions, cookie + CSRF authentication of the session API (the stub has none), file watching
(`watch` is a no-op), Windows and macOS desktop builds.

## Consequences

- **ADR-006 accepted: option B** (see `05_ADR/ADRS.md`).
- Phase 08 (broker + remote terminal) and 09 (remote filesystem), `qe-remote`: build on the spike's structure —
  terminal via `isPseudoTerminal` with the size sent after the stream opens, broker queues early input, provider
  registered by a dependency-free `FileServiceContribution`, `ifMatch` on writes; port `verify/check.mjs` into
  the e2e suite.
- Phase 08: contract addendum for clients without `Origin` (Bearer only) and the broker mapping `signal` to
  `\x03`; Phase 09: `ifMatch` on `fs/write`.
- Phase 10 (desktop): `ConnectionClient` relayed through the Electron backend; never expose tokens to the
  renderer.
- Risk R2 stays open with a lower likelihood; R17 (desktop renderer origin) added.
