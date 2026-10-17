# Prompt Pack — Phase 02: Theia Product Shell (Browser + Desktop)

Phase guide: `02_PHASES/PHASE_02_THEIA_PRODUCT_SHELL.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P02.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P02.1 … P02.7 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P02.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 02 — Theia Product Shell (Browser + Desktop)
Read docs/phases/PHASE_02_THEIA_PRODUCT_SHELL.md (copy of the kit's phase guide) fully before anything else.
GOAL: Build apps/ide-browser and apps/ide-electron from the same qe-core extension, branded QE Workspace, extensions from internal Open VSX.
IN SCOPE: apps/ide-browser; apps/ide-electron; extensions/qe-core; images/workspace-runtime; tests/e2e/smoke*
OUT OF SCOPE (do not touch): control plane; remote features
ACCEPTANCE: Same QE commands in browser and Electron; extensions only from internal registry; runtime image non-root.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 02`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P02.1 — Browser app

```text
Create apps/ide-browser per the phase guide with the @theia package set validated in spike S1, all @theia
versions pinned identically, theiaPlugins pointing at the internal Open VSX URL (placeholder env), scripts
build/start/download:plugins. Build and start it; report the URL works.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P02.2 — Electron app

```text
Create apps/ide-electron with the same dependency set + @theia/electron and electron-builder config (appId
corp.qe.workspace). Build and start it on this OS. Add a script that fails CI if @theia versions differ
between the two apps.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P02.3 — qe-core extension

```text
Create extensions/qe-core with frontend and backend modules, QeCommands (qe.workspace.open, qe.remote.connect,
qe.runner.run, qe.about) — only qe.about implemented, others show 'available in a later phase'. Register via
ContainerModule. Unit test command registration.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P02.4 — QeEnvironment + preferences

```text
Implement QeEnvironment (mode hosted|local-web|desktop) populated from Electron detection or a backend
endpoint reading validated env vars QE_MODE, QE_CONTROL_PLANE_URL, QE_WORKSPACE_ID. Contribute qe.*
preferences schema. Never read mode from query params. Tests for env parsing.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P02.5 — Branding + welcome

```text
Apply product name, icons, about dialog, window title and a QE welcome page (Open project, Connect remote, Run
tests, Docs).

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P02.6 — Runtime dev image

```text
Create images/workspace-runtime/Dockerfile (multi-stage, non-root UID 1000, tini, git, python3, ripgrep) that
runs the browser app on port 3000 with /home/qe/project as workspace. Build it and run it; show `id` inside is
uid=1000.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P02.7 — Smoke E2E

```text
Add Playwright smoke tests: browser (title, explorer, command palette shows 'QE: About QE Workspace') and
Electron via _electron.launch. Wire browser smoke into CI.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run build -w @qe/ide-browser
npm run build -w @qe/ide-electron
npx playwright test tests/e2e/smoke.browser.spec.ts
docker build -f images/workspace-runtime/Dockerfile -t qews/runtime:dev .
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Same QE commands in browser and Electron; extensions only from internal registry; runtime image non-root.
