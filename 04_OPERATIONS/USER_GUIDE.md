# QE Workspace — User Guide (draft; finalise in Phase 18 from implemented behaviour)

## 1. Choose how to run it
| You want… | Use |
|---|---|
| Nothing installed, any machine | **Web**: `https://qe-workspace.<corp>` |
| Native app on your laptop | **Desktop**: install from Software Center |
| Browser UI but code on your laptop | **Local web**: `qe-workspace-local` launcher (Docker required) |

## 2. Web: first steps
1. Sign in with company SSO.
2. **New Workspace** → choose template (e.g. *Python pytest*) → paste Git URL → Create → Start.
3. The IDE opens. Your files persist; idle workspaces stop automatically after the configured time — just open them again.

## 3. Editing & terminal
- Same shortcuts as VS Code (`Ctrl+P`, `Ctrl+Shift+P`, `` Ctrl+` ``).
- Terminal runs inside your workspace (not your laptop). Ctrl+C stops processes.
- Extensions: only approved ones from the internal registry.

## 4. Connect to another system
1. Open **Remote Connections** (activity bar).
2. Pick a target → **Open Terminal** or **Open Remote Folder**.
3. You'll see the verified host-key fingerprint. You never need an SSH key — access is granted by your role and issued just-in-time.
4. Files you edit are limited to the target's project folder.
5. Sessions end on disconnect, idle timeout or at the max session time.

**Desktop/local only — personal hosts:** hosts from your `~/.ssh/config` appear under *Personal*; your ssh-agent/keys are used locally and never uploaded. First connection asks you to confirm the host key.

## 5. Run tests
QE panel → discover → Run all / file / selected → live console → results with failures (click to open) → reports/artifacts. Choose **Run on: workspace | remote target**.

## 6. Troubleshooting
| Message | Meaning / action |
|---|---|
| Not allowed to connect | You lack the role for this lab — request access |
| Host key mismatch | Possible security issue — do not retry; contact lab admin |
| Credentials unavailable | Platform issue — try later; check status page |
| Session expired | Reconnect |
| Path outside root | You tried to access files outside the allowed folder |
