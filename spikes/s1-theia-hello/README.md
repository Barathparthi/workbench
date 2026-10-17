# Spike S1 — Theia hello (browser + Electron)

Throwaway code for Phase 00 spike S1 (`02_PHASES/PHASE_00_ENVIRONMENT_DECISIONS_SPIKES.md` step 0.4).
Not product code: it is outside the root npm workspaces, lint, format and test runs.
Results: [`docs/spikes/S1_THEIA_HELLO.md`](../../docs/spikes/S1_THEIA_HELLO.md).

One extension (`qe-hello`, command `qe.hello` → "QE: Say Hello") is used unchanged by a browser app and an
Electron app, both on Theia 1.76.0.

## Prerequisites

- Node.js 24 (`.nvmrc` at the repository root), npm 11.
- Linux: `sudo apt-get install -y libx11-dev libxkbfile-dev libsecret-1-dev` (native modules
  `native-keymap` and `keytar` compile from source).
- npm 11.19+ only runs dependency install scripts listed under `allowScripts` in `package.json`; the
  native modules Theia needs are approved there, `puppeteer` (a Chrome download) is denied.

## Commands

```bash
npm install
npm run build:browser            # extension + browser app
npm run start:browser            # http://127.0.0.1:3000
npm run build:electron           # rebuilds native modules for Electron (needs artifacts.electronjs.org)
npm run build:electron:napi      # same build without the rebuild — works because every native module is Node-API
npm run start:electron

# Automated checks (palette → "QE: Say Hello" → notification; terminal → shell writes a marker file)
node verify/browser.mjs out-browser.png                     # browser app must be running
xvfb-run -a node verify/electron.mjs out-electron.png       # headless Linux; drop xvfb-run on a desktop
```
