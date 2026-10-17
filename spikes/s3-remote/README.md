# Spike S3 — remote terminal + remote files inside Theia

Throwaway code for Phase 00 spike S3 (`02_PHASES/PHASE_00_ENVIRONMENT_DECISIONS_SPIKES.md` step 0.6).
Not product code: it is outside the root npm workspaces, lint, format and test runs.
Results and the ADR-006 decision: [`docs/spikes/S3_REMOTE_TERMINAL_FS.md`](../../docs/spikes/S3_REMOTE_TERMINAL_FS.md).

The same feature — a remote terminal and a remote `hello.txt` you can edit, both through a broker — built twice
on Theia 1.76.0 and loaded side by side into one browser app and one Electron app:

| Path | What |
| --- | --- |
| `vscode-plugins/qe-remote-a/` | **Option A**: VS Code web extension (`browser` entry only, plain JS): `Pseudoterminal` + `FileSystemProvider` for `qe-ssh-a://`, plus a webview command. |
| `qe-remote-b/` | **Option B**: Theia frontend extension: `TerminalWidget` with `isPseudoTerminal` + `FileSystemProvider` for `qe-ssh-b://` registered through a `FileServiceContribution`. |
| `broker-stub/` | Stub of the contract's session API (`POST …/targets/{id}/sessions`, ticket WebSocket `qews.v1`, `POST …/sessions/{id}/fs/{op}`) over `ssh2` to the S4 OpenSSH target. One hard-coded target, in-memory tickets, pinned host key, Origin check. |
| `browser-app/`, `electron-app/` | Theia apps containing both options. |
| `verify/check.mjs` | Playwright checks per option: terminal → marker file on the remote host, Ctrl+C, open/edit/save the remote file; webview origin. |

## Prerequisites

- Everything from [`spikes/s1-theia-hello`](../s1-theia-hello/README.md#prerequisites) (Node 24, native-module
  build packages, `allowScripts`).
- The S4 environment (OpenSSH target on `:2222` with keys under `/srv/qe-s4`):
  [`spikes/s4-ssh2/env.sh`](../s4-ssh2/README.md).
- The checks read and reset `/home/qeuser/project/hello.txt` on the local machine, which is the "lab host" here.

## Commands

```bash
VAULT=/path/to/vault ../s4-ssh2/env.sh up          # target sshd (+ Vault, unused here)
install -d -o qeuser -g qeuser /home/qeuser/project
echo 'hello from the lab host' | install -o qeuser -g qeuser /dev/stdin /home/qeuser/project/hello.txt

npm install && (cd broker-stub && npm install)
node broker-stub/server.mjs &                      # http://127.0.0.1:8082

npm run build:browser
(cd browser-app && npm start -- /path/to/empty/workspace) &   # http://127.0.0.1:3000, loads ../vscode-plugins
node verify/check.mjs browser http://localhost:3000 out   # localhost, not 127.0.0.1: webviews need a host name

node node_modules/electron/install.js              # if the Electron binary is missing
npm run build:electron:napi
xvfb-run -a -s "-screen 0 1280x800x24" node verify/check.mjs electron - out
```

`OPTIONS=B node verify/check.mjs …` runs one option only. Each check group starts with
"Reset Workbench Layout": clearing storage and reloading is not enough, because Theia stores the layout again
on unload and restores the previous group's editors.
