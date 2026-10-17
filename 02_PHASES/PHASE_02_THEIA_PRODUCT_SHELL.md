# Phase 02 — Theia Product Shell (Browser **and** Desktop)

| | |
|---|---|
| **Goal** | "QE Workspace" IDE builds and runs as a browser app and an Electron app from the same extensions |
| **Duration** | 1–1.5 weeks |
| **Prerequisites** | Phase 01; ADR-005/006 from spikes |
| **Prompt pack** | `03_PROMPTS/PHASE_02_PROMPTS.md` |

## Deliverables
- `apps/ide-browser` (target `browser`) and `apps/ide-electron` (target `electron`).
- `extensions/qe-core`: branding, `QeEnvironment`, commands, settings schema, status bar item.
- Built-in VS Code plugins downloaded at build (git, language basics, themes) from internal Open VSX.
- Workspace runtime **dev image** that runs the browser app (used in Phase 05).
- Smoke E2E: IDE loads in browser; Electron launches (Playwright `_electron`).

## Step-by-step

### Step 2.1 — Browser app package
```json
// apps/ide-browser/package.json (excerpt — exact @theia package list from spike S1)
{
  "name": "@qe/ide-browser", "private": true,
  "theia": {
    "target": "browser",
    "frontend": { "config": {
      "applicationName": "QE Workspace",
      "defaultTheme": { "light": "light", "dark": "dark" },
      "preferences": { "files.enableTrash": false, "security.workspace.trust.enabled": true }
    }},
    "backend": { "config": { "startupTimeout": -1 } }
  },
  "dependencies": {
    "@theia/core": "<pinned>", "@theia/editor": "<pinned>", "@theia/filesystem": "<pinned>",
    "@theia/markers": "<pinned>", "@theia/messages": "<pinned>", "@theia/monaco": "<pinned>",
    "@theia/navigator": "<pinned>", "@theia/outline-view": "<pinned>", "@theia/output": "<pinned>",
    "@theia/preferences": "<pinned>", "@theia/process": "<pinned>", "@theia/search-in-workspace": "<pinned>",
    "@theia/terminal": "<pinned>", "@theia/workspace": "<pinned>", "@theia/scm": "<pinned>",
    "@theia/plugin-ext": "<pinned>", "@theia/plugin-ext-vscode": "<pinned>", "@theia/vsx-registry": "<pinned>",
    "@theia/keymaps": "<pinned>", "@theia/getting-started": "<pinned>",
    "@qe/theia-qe-core": "0.0.0"
  },
  "devDependencies": { "@theia/cli": "<pinned>" },
  "scripts": {
    "prepare": "npm run download:plugins",
    "build": "theia build --mode production",
    "start": "theia start --hostname 127.0.0.1 --port 3000 --plugins=local-dir:../../plugins",
    "download:plugins": "theia download:plugins --rate-limit=15 --parallel=false"
  },
  "theiaPluginsDir": "../../plugins",
  "theiaPlugins": {
    "vscode.git": "<internal-openvsx>/api/vscode/git/<ver>/file/vscode.git-<ver>.vsix",
    "vscode.python": "<…>", "vscode.json": "<…>", "vscode.yaml": "<…>", "vscode.theme-defaults": "<…>"
  }
}
```
Set the Open VSX registry URL for `@theia/vsx-registry` to the internal mirror (env
`VSX_REGISTRY_URL` or app config — check your Theia version) and **disable** public marketplace access
in hosted builds.

### Step 2.2 — Electron app package
Same `dependencies` + `@theia/electron`, `"target": "electron"`, scripts `build`, `start`
(`theia start`), `package` (`electron-builder`), and `electron-builder.yml` with `appId:
corp.qe.workspace`, product name, icons, Windows NSIS, macOS dmg (hardened runtime), Linux AppImage.

### Step 2.3 — `qe-core` extension
```text
extensions/qe-core/
  package.json            "theiaExtensions":[{"frontend":"lib/browser/qe-core-frontend-module",
                                              "backend":"lib/node/qe-core-backend-module"}]
  src/common/qe-environment.ts
  src/common/qe-preferences.ts
  src/browser/qe-core-frontend-module.ts
  src/browser/qe-commands.ts
  src/browser/qe-status-bar.ts
  src/node/qe-core-backend-module.ts
```
```ts
// src/browser/qe-commands.ts
import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry, MessageService } from '@theia/core/lib/common';

export namespace QeCommands {
  export const CATEGORY = 'QE';
  export const OPEN_WORKSPACE: Command = { id: 'qe.workspace.open', category: CATEGORY, label: 'Open Workspace…' };
  export const CONNECT_TARGET: Command = { id: 'qe.remote.connect', category: CATEGORY, label: 'Connect to Remote System…' };
  export const RUN_TESTS:      Command = { id: 'qe.runner.run',     category: CATEGORY, label: 'Run Tests' };
  export const ABOUT:          Command = { id: 'qe.about',          category: CATEGORY, label: 'About QE Workspace' };
}

@injectable()
export class QeCommandContribution implements CommandContribution {
  @inject(MessageService) protected readonly messages!: MessageService;
  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(QeCommands.ABOUT, { execute: () => this.messages.info('QE Workspace') });
    // OPEN_WORKSPACE / CONNECT_TARGET / RUN_TESTS registered as placeholders; implemented in later phases
  }
}
```
```ts
// src/browser/qe-core-frontend-module.ts
import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common';
import { QeCommandContribution } from './qe-commands';
export default new ContainerModule(bind => {
  bind(QeCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(QeCommandContribution);
});
```

### Step 2.4 — `QeEnvironment`
```ts
export type QeMode = 'hosted' | 'local-web' | 'desktop';
export interface QeEnvironment {
  mode: QeMode;
  controlPlaneUrl?: string;      // hosted or signed-in local/desktop
  workspaceId?: string;          // hosted
  features: { personalTargets: boolean; managedTargets: boolean; workspacePicker: boolean };
}
```
Populate from: Electron → `desktop`; browser → backend endpoint `/qe/env` that reads `QE_MODE`,
`QE_CONTROL_PLANE_URL`, `QE_WORKSPACE_ID` env vars (validated with Zod). Never trust a query parameter.

### Step 2.5 — Preferences schema
Contribute `qe.*` preferences via `PreferenceContribution`: `qe.remote.defaultShell`,
`qe.runner.framework`, `qe.runner.junitGlob`, `qe.telemetry.enabled` (desktop only).

### Step 2.6 — Branding
Product name, icons, about dialog, welcome page replacing "getting started" content with QE quick
links (Open project, Connect remote, Run tests, Docs). Window title format.

### Step 2.7 — Runtime dev image (preview of Phase 05)
`images/workspace-runtime/Dockerfile`:
```dockerfile
FROM node:<lts>-bookworm@sha256:<digest> AS build
WORKDIR /src
COPY . .
RUN npm ci && npm run build -w @qe/ide-browser && npm prune --omit=dev

FROM debian:bookworm-slim@sha256:<digest>
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl procps less vim-tiny python3 python3-venv python3-pip \
      ripgrep tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN useradd -m -u 1000 -s /bin/bash qe
COPY --from=build --chown=root:root /src /opt/qe-workspace
USER 1000:1000
WORKDIR /home/qe/project
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","/opt/qe-workspace/apps/ide-browser/lib/backend/main.js","/home/qe/project","--hostname=0.0.0.0","--port=3000","--plugins=local-dir:/opt/qe-workspace/plugins"]
```
(Exact paths depend on Theia build output — verify.)

### Step 2.8 — Smoke tests
- Playwright `tests/e2e/smoke.browser.spec.ts`: page title, explorer visible, command palette shows "QE: About".
- Playwright `_electron.launch` smoke for desktop (nightly on all OSes).

## Exit criteria
- [ ] `npm run build -w @qe/ide-browser` and `-w @qe/ide-electron` succeed in CI.
- [ ] Browser app opens; explorer, editor, terminal, search, git work on a sample repo.
- [ ] Electron app opens with the same QE commands.
- [ ] Extensions load only from the internal registry (verified by network log).
- [ ] Runtime dev image builds and runs as UID 1000.

## Pitfalls
- Different `@theia/*` versions in the two apps → keep versions in one place (root `overrides` or a
  sync check script).
- Including `@theia/vsx-registry` with the public registry in hosted builds.
- Forgetting `security.workspace.trust` behaviour for plugins in hosted mode.
