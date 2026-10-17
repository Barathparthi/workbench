# Phase 06 — Integrated Terminal Hardening

| | |
|---|---|
| **Goal** | The built-in Theia terminal in each runtime is reliable, bounded and observable |
| **Duration** | 4–5 days |
| **Prerequisites** | Phase 05 |
| **Prompt pack** | `03_PROMPTS/PHASE_06_PROMPTS.md` |

> We do **not** rebuild the local terminal — Theia already ships xterm.js + node-pty. This phase verifies, hardens and instruments it behind the router.

## Step-by-step

### 6.1 Write E2E checks first
| Behaviour | Check |
|---|---|
| Interactive | `python3` REPL, `vim`, `top`, `less` render correctly |
| Resize | `tput cols; tput lines` match widget after resize |
| Ctrl+C | `sleep 100` interrupted < 1 s |
| Exit | `exit` closes terminal; exit code shown |
| Unicode/colours | UTF-8 box drawing + 256 colours |
| Reconnect | Proxy restart → Theia reconnects; terminal reattaches or shows a clear state |
| Throughput | `yes \| head -n 2000000` does not freeze UI; memory bounded |

### 6.2 Shell configuration
- Default `/bin/bash -l`; `qe.terminal.shell` limited to an allowlist.
- `TERM=xterm-256color`, `LANG=C.UTF-8`; one-line banner with workspace name and image version.

### 6.3 Limits
- Max terminals per workspace (e.g. 10) enforced in a backend contribution.
- Scrollback cap (e.g. 10,000 lines).
- PIDs limit from Phase 05 protects against fork bombs — test it.
- Router keeps quiet terminals alive with WS pings; frame limits don't break large pastes.

### 6.4 Process cleanup
- Terminal close → PTY process group gets SIGHUP, SIGKILL after 5 s.
- Workspace stop → pod termination; `tini` reaps zombies.

### 6.5 Telemetry
`qews.terminals.active{mode="local"}`, `qews.terminal.open.duration`, `qews.ws.disconnects`. **Never** capture terminal bytes.

### 6.6 Tasks
Support `.vscode/tasks.json` in templates (e.g. "pytest" task with a problem matcher).

## Tests
- Playwright E2E for each row in 6.1 (stable selectors, no fixed sleeps).
- Fork-bomb test in an isolated workspace: runtime survives; other workspaces unaffected.
- 4 h soak with periodic output; memory stable.

## Exit criteria
- [ ] All 6.1 behaviours green in hosted, local-web and Electron.
- [ ] Limits enforced and tested; metrics visible.
