# Spike S5 — Open VSX availability of the required VS Code extensions

**Date:** 2026-10-17 · **Phase:** 00, step 0.8 · **Code:** [`spikes/s5-openvsx/`](../../spikes/s5-openvsx/) ·
**Run:** GitHub Actions job `openvsx` in run [39029039301](https://github.com/Barathparthi/workbench/actions/runs/39029039301)
(PR #3) — the development sandbox cannot reach open-vsx.org, GitHub's runners can · **Registry:**
`https://open-vsx.org` · **Theia VS Code API:** 1.139.0 (`DEFAULT_SUPPORTED_API_VERSION` of
`@theia/application-package` 1.76.0)

## Question

Are the extensions in org decision A8 (Python, Java, YAML, a GitLens alternative, Robot Framework) available on
Open VSX in versions Theia 1.76 can run, and what replaces the ones that are not?

## Result

**Every required extension is on Open VSX, from a verified publisher, and its latest version is compatible with
Theia 1.76** (its `engines.vscode` minimum ≤ 1.139.0). As expected, **Pylance** and **Remote-SSH** (Microsoft
licence, VS Code only) are missing; both have answers below.

| Area | Extension | Need | On Open VSX | Latest | Published | `engines.vscode` | Theia 1.76 | Licence | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Python | `ms-python.python` | required | ✔ | 2026.4.0 | 2026-03-13 | ^1.95.0 | ✔ | MIT | ✔ |
| Python | `ms-python.debugpy` | required | ✔ | 2026.6.0 | 2026-05-01 | ^1.92.0 | ✔ | MIT | ✔ |
| Python | `ms-python.vscode-pylance` | (expected missing) | ✘ | | | | | | |
| Python | `detachhead.basedpyright` | alternative | ✔ | 1.40.2 | 2026-10-04 | ^1.101.0 | ✔ | MIT | ✔ |
| Python | `ms-pyright.pyright` | alternative | ✔ | 1.1.402 | 2025-06-12 | ^1.99.0 | ✔ | MIT | ✔ |
| Python | `charliermarsh.ruff` | alternative | ✔ | 2026.88.0 | 2026-10-15 | ^1.91.0 | ✔ | MIT | ✔ |
| Python | `ms-toolsai.jupyter` | alternative | ✔ | 2025.9.1 | 2025-10-14 | ^1.105.0 | ✔ | MIT | ✔ |
| Java | `redhat.java` | required | ✔ | 1.58.2026101608 | 2026-10-16 | ^1.77.0 | ✔ | EPL-2.0 | ✔ |
| Java | `vscjava.vscode-java-debug` | required | ✔ | 0.60.0 | 2026-10-15 | ^1.95.0 | ✔ | "SEE LICENSE IN LICENSE.txt" | ✔ |
| Java | `vscjava.vscode-java-test` | required | ✔ | 0.47.0 | 2026-10-15 | ^1.88.0 | ✔ | (not declared) | ✔ |
| Java | `vscjava.vscode-maven` | required | ✔ | 0.45.3 | 2026-04-27 | ^1.75.0 | ✔ | MIT | ✔ |
| YAML | `redhat.vscode-yaml` | required | ✔ | 2.1.2026101708 | 2026-10-17 | ^1.91.0 | ✔ | MIT | ✔ |
| Git | `eamodio.gitlens` | alternative | ✔ | 2026.10.170513 | 2026-10-17 | ^1.101.0 | ✔ | (placeholder `%gitlens.license%`) | ✔ |
| Git | `mhutchie.git-graph` | alternative | ✔ | 1.30.0 | 2021-04-17 | ^1.38.0 | ✔ | (not declared) | ✔ |
| Git | `donjayamanne.githistory` | alternative | ✔ | 0.6.20 | 2023-03-06 | ^1.76.0 | ✔ | MIT | ✔ |
| Robot Framework | `d-biehl.robotcode` | required | ✔ | 2.7.0 | 2026-07-14 | ^1.108.0 | ✔ | (not declared) | ✔ |
| Robot Framework | `robocorp.robotframework-lsp` | alternative | ✘ | | | | | | |
| Built-in | `vscode.git` | built-in | ✔ | 1.95.3 | 2024-12-10 | ^1.5.0 | ✔ | VS Code (MIT) | ✔ |
| Built-in | `vscode.python` | built-in | ✔ | 1.95.3 | 2024-12-10 | * | ✔ | VS Code (MIT) | ✔ |
| Built-in | `vscode.json-language-features` | built-in | ✔ | 1.95.3 | 2024-12-10 | ^1.77.0 | ✔ | VS Code (MIT) | ✔ |
| Built-in | `vscode.yaml` | built-in | ✔ | 1.95.3 | 2024-12-10 | * | ✔ | VS Code (MIT) | ✔ |
| Built-in | `vscode.markdown-language-features` | built-in | ✔ | 1.95.3 | 2024-12-10 | ^1.70.0 | ✔ | VS Code (MIT) | ✔ |
| Built-in | `vscode.theme-defaults` | built-in | ✔ | 1.95.3 | 2024-12-10 | * | ✔ | VS Code (MIT) | ✔ |
| Remote | `ms-vscode-remote.remote-ssh` | (expected missing) | ✘ | | | | | | |

Platform-specific builds exist for `ms-python.debugpy`, `charliermarsh.ruff` and `redhat.java` (linux/darwin/win32
× x64/arm64); the rest are universal. Raw output: the job log of the run above (table + JSON).

## Findings

1. **Pylance → `detachhead.basedpyright`.** Pylance is Microsoft-licensed for VS Code only and not on Open VSX.
   basedpyright (MIT, actively maintained, published 2026-10-04) gives Pylance-like type checking and
   completion; `ms-pyright.pyright` is older (last 2025-06-12). Add `charliermarsh.ruff` for lint/format.
2. **Microsoft-published extensions lag on Open VSX.** `ms-python.python` is 2026.4.0 (March 2026) and
   `ms-toolsai.jupyter` 2025.9.1 (October 2025) — months behind their VS Code Marketplace releases. They work,
   but features arrive late; pin versions and review the lag at each Theia upgrade.
3. **Built-in extensions on Open VSX are at VS Code 1.95.3 (December 2024).** Compatible, but Phase 02 should
   check Theia's own built-in pack (`eclipse-theia.builtin-extension-pack`) and use whichever is newer.
4. **Licences to review before allowlisting (ADR-010):** `vscjava.vscode-java-debug` ("see licence file"),
   `vscjava.vscode-java-test`, `d-biehl.robotcode`, `mhutchie.git-graph` (no licence declared in Open VSX
   metadata), and **GitLens** (its metadata licence is an unresolved placeholder; GitLens includes paid "Pro"
   features). Default Git UI: Theia's built-in SCM + `vscode.git`; add GitLens only after the licence review.
5. **Remote-SSH is not needed:** QE Workspace provides remote terminals and files through its own broker
   (Phases 07–09); Microsoft's Remote-SSH is licensed for VS Code only.
6. **Robot Framework:** `d-biehl.robotcode` is available and current; Robocorp's extension is not on Open VSX.
7. **Mirror:** the check runs unchanged against an internal mirror (`OPENVSX_URL=…`), which is the plan in
   ADR-010 / org decision D7.

## Proposed extension allowlist (for org decision A8; licence review pending where marked)

| Purpose | Extension | Note |
| --- | --- | --- |
| Python language | `ms-python.python`, `ms-python.debugpy` | |
| Python types/completion | `detachhead.basedpyright` | replaces Pylance |
| Python lint/format | `charliermarsh.ruff` | |
| Java | `redhat.java`, `vscjava.vscode-java-debug`¹, `vscjava.vscode-java-test`¹, `vscjava.vscode-maven` | |
| YAML | `redhat.vscode-yaml` | |
| Robot Framework (if used) | `d-biehl.robotcode`¹ | |
| Git | built-in `vscode.git` (+ `eamodio.gitlens`¹ optional) | |
| Notebooks (optional) | `ms-toolsai.jupyter` | lags upstream |

¹ licence review before allowlisting.

## Not covered

- Installing and exercising the extensions inside Theia (Phase 02, with `@theia/plugin-ext` and
  `theia download:plugins`) — availability and declared engine compatibility only.
- An internal Open VSX mirror (org decision D7).
