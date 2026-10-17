# Spike S1 — Theia hello app (browser + Electron)

**Date:** 2026-10-17 · **Phase:** 00, step 0.4 · **Code:** [`spikes/s1-theia-hello/`](../../spikes/s1-theia-hello/)
· **Environment:** Linux x64 cloud container, Node 24.22.0, npm 11.19.1, no GPU, `xvfb` for Electron

## Question

Can one Theia extension run unchanged in a browser app **and** an Electron app on the pinned toolchain, and
what does it take to build them? Which Theia version should Phase 02 pin?

## Result

**Yes.** One extension (`qe-hello`, command `qe.hello` "QE: Say Hello") was built once and used by both
apps on **Theia 1.76.0**. An automated check opened the command palette, ran the command and read the
notification, then opened an integrated terminal and had the shell write a marker file. (Earlier failing
runs were bugs in the check itself — see finding 8 — not in the apps.)

| Target | Command result | Terminal (node-pty) | Shell ready | Passing runs |
| --- | --- | --- | --- | --- |
| Browser (Chromium, headless) | "Hello from QE Workspace (browser)" | shell spawned ✔ | ~2.3 s after page load | command 4/4, terminal 1/1 |
| Electron 42.8.1 (under `xvfb`) | "Hello from QE Workspace (electron)" | shell spawned ✔ | ~0.3–0.9 s after window | command 4/4, terminal 1/1 |

Actual output of the final runs:

```text
$ node verify/browser.mjs docs/spikes/s1/browser-qe-hello.png
{"target":"browser","url":"http://127.0.0.1:3000","shellReadyMs":2203,"trustPrompted":false,"message":"Hello from QE Workspace (browser)","terminalOk":true,"totalMs":9799,...}
$ xvfb-run -a node verify/electron.mjs docs/spikes/s1/electron-qe-hello.png <workspace>
{"target":"electron","shellReadyMs":856,"trustPrompted":false,"message":"Hello from QE Workspace (electron)","terminalOk":true,"totalMs":10707,...}
```

Screenshots: [browser](s1/browser-qe-hello.png) · [Electron](s1/electron-qe-hello.png).

**Recommendation: pin Theia 1.76.0** (npm `latest`, released 2026-09-24) for Phase 02, with Electron
42.8.1. The alternative 1.74.2 was not needed: 1.76.0 built and ran without workarounds in Theia itself.

## Measurements

| Item | Value |
| --- | --- |
| `npm install` (866 packages, warm network) | 39 s |
| `node_modules` | 704 MB including the Electron binary (310 MB) |
| Browser build, development (`tsc` + `theia build`) | 18 s total; esbuild: frontend 4.4 s, backend 1.6 s |
| Browser build, production | 8 s |
| Electron build, development (without native rebuild) | 20 s |
| Production frontend `bundle.js` | 12.4 MB (3.3 MB gzip); `lib/frontend` 56 MB without source maps, incl. pre-compressed `.gz` copies (plus 97 MB of maps) |
| Electron binary download | 5 s (from GitHub releases) |

## Findings (what Phase 02 must account for)

1. **Theia 1.76 builds with esbuild, not webpack.** `theia build` writes `gen-esbuild.*.mjs` (regenerated
   every build — git-ignored) and an editable `esbuild.mjs` (created once — commit it). The kit's mentions
   of `gen-webpack.config.js` are out of date; `.gitignore` and the ESLint ignores now cover both.
2. **Linux build prerequisites.** `native-keymap` (dependency of `@theia/electron`) compiles from source
   and failed until `libx11-dev` and `libxkbfile-dev` were installed; `keytar` needs `libsecret-1-dev`.
   These go into the developer prerequisites, the CI desktop job and the runtime build image.
3. **npm 11.19 install-script approval.** npm now skips dependency install scripts that are not listed
   under `allowScripts` in `package.json` (`npm install-scripts approve <pkg>`). Theia needs approvals for
   `node-pty`, `native-keymap`, `keytar`, `drivelist`, `@theia/ffmpeg`, `@parcel/watcher`,
   `msgpackr-extract` and `esbuild`; `puppeteer` (downloads Chrome) can be denied. Without approvals the
   install "succeeds" but native modules are missing.
4. **Electron native rebuild needs `artifacts.electronjs.org`.** `theia rebuild:electron` downloads
   Electron headers for node-gyp; this sandbox's network policy blocks electronjs.org (GitHub releases are
   allowed, so the Electron binary itself downloaded fine). Every native module in this app uses
   **Node-API** (`node-pty`, `keytar`, `drivelist`, `native-keymap`, `@theia/ffmpeg`), so the Node builds
   loaded in Electron unchanged — proven by the terminal check. Production builds should still rebuild,
   so CI needs electronjs.org or an internal mirror (`npm_config_disturl` / `ELECTRON_MIRROR`) —
   new org decision D12.
5. **Workspace Trust is on by default.** Opening a folder shows a trust dialog that takes focus; the Phase 02
   config keeps `security.workspace.trust.enabled: true`, so E2E tests must handle it (the S1 check does).
6. **`node-pty` ships prebuilds** for linux/darwin/win32 × x64/arm64, so Windows developers do not need a
   C++ toolchain for the terminal (the kit's step 0.4.6 concern). Windows/macOS were not run here; the
   desktop CI matrix covers that in Phase 02.
7. **Codecs.** `theia build` for Electron replaces Electron's `libffmpeg.so` with `@theia/ffmpeg`'s build
   without proprietary codecs — relevant to licensing review, no action needed.
8. **Test automation notes.** Monaco's quick input reacts to key events (Playwright `fill()` is ignored,
   use `keyboard.type`), and notifications render twice (toast + hidden notification centre) — select the
   visible one. Playwright `_electron` drives the Electron app headless under `xvfb`.

## Not covered (other spikes)

- Base path / reverse proxy (S2), remote terminal & FS approach (S3), `ssh2` (S4), Open VSX availability (S5).
- Plugin host and VS Code extensions (`@theia/plugin-ext*`, `@theia/vsx-registry`) — Phase 02 adds them.
- Windows and macOS builds, packaging and signing (`electron-builder`) — Phase 02 / 15.
