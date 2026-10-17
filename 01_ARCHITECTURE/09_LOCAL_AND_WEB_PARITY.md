# 09 — Local and Web Parity ("it must work on both")

The requirement: **the same product must work locally and on the web.** This document defines exactly
what "same" means and how the codebase guarantees it.

## 1. The three modes

| | Hosted Web | Local Web | Desktop |
|---|---|---|---|
| Theia target | `browser` | `browser` | `electron` |
| App package | `apps/ide-browser` | `apps/ide-browser` | `apps/ide-electron` |
| Where backend runs | K8s runtime pod | Docker on laptop (or `npm start`) | Electron main/backend process on laptop |
| Files | PVC in cluster | Bind-mounted folder | Local disk |
| Terminal | node-pty in pod | node-pty in container | node-pty on host OS (cmd/pwsh/bash/zsh) |
| Login | OIDC (mandatory) | None (single-user) or OIDC to hosted | Optional OIDC (PKCE, system browser) |
| Managed targets | Hosted broker | Hosted broker (if signed in) | Hosted broker (if signed in) |
| Personal targets | ✘ | Embedded broker | Embedded broker |
| QE runner | In pod | In container | On host |
| Extensions | Internal Open VSX | Internal Open VSX | Internal Open VSX (or offline bundle) |

## 2. Parity contract

**Must be identical across modes** (tested by `tests/parity`):
1. Editor, explorer, search, SCM, keybindings, themes, settings schema.
2. QE commands and their IDs (`qe.workspace.open`, `qe.remote.connect`, `qe.runner.run`, …).
3. Remote Connections view: same tree, same actions, same states, same error messages.
4. Remote terminal behaviour (resize, Ctrl+C, close codes surfaced the same way).
5. Remote file operations semantics (confinement, conflict handling, size limits).
6. QE runner UI, result model, JUnit parsing.
7. Settings file format (`.qe-workspace/settings.json`) and workspace template format.

**Allowed to differ** (documented, surfaced in UI):
- Authentication flow; presence of workspace picker (hosted only).
- Personal targets (local/desktop only).
- Resource limits (hosted only).

## 3. How the code enforces parity

### 3.1 One set of extensions, environment bound via DI

```ts
// extensions/qe-remote/src/common/connection-client.ts
export const ConnectionClient = Symbol('ConnectionClient');
export interface ConnectionClient {
  listTargets(): Promise<TargetSummary[]>;               // managed + personal merged
  openTerminal(targetId: string, size: TermSize): Promise<RemoteTerminalHandle>;
  fs(targetId: string): Promise<RemoteFsHandle>;
  close(sessionId: string): Promise<void>;
}
```

Bindings:

| Module | Mode | Binds |
|---|---|---|
| `qe-remote-frontend-module.ts` | browser | `HostedConnectionClient` (REST/WSS to control plane + broker) **and**, if `QE_MODE=local-web`, `CompositeConnectionClient(hosted?, embeddedViaBackendRpc)` |
| `qe-remote-electron-frontend-module.ts` (`frontendElectron`) | desktop | `CompositeConnectionClient(hostedIfSignedIn, embeddedViaBackendRpc)` |
| `qe-remote-backend-module.ts` (`backend`, local-web only) and `backendElectron` | local | `EmbeddedBrokerService` exposing personal targets via Theia RPC |

Theia's extension `package.json` supports separate entry points:

```json
"theiaExtensions": [{
  "frontend": "lib/browser/qe-remote-frontend-module",
  "frontendElectron": "lib/electron-browser/qe-remote-electron-frontend-module",
  "backend": "lib/node/qe-remote-backend-module",
  "backendElectron": "lib/electron-node/qe-remote-electron-backend-module"
}]
```

### 3.2 Environment detection
`qe-core` exposes `QeEnvironment` (`{ mode: 'hosted'|'local-web'|'desktop', controlPlaneUrl?, features }`)
populated from Theia application config (`frontend.config`) + `/api/v1/me` capabilities. UI hides
unavailable features **and** the backend enforces them — never only the UI.

### 3.3 One protocol for the remote terminal
Both hosted and embedded brokers speak `qews.v1` (05_API_CONTRACTS §4). In desktop, the embedded
broker's stream is carried over Theia RPC/local WS but uses the **same message schema** and the same
frontend terminal adapter.

### 3.4 Shared broker library
`packages/broker-core` is used by the hosted `connection-broker` app **and** by the embedded broker.
Differences are injected: `TargetSource`, `CredentialSource`, `HostKeyStore`, `AddressGuard`, `AuditSink`.

```text
                 broker-core (SshTransport, channels, confine(), session registry, limits)
                 /                                                     \
hosted: RegistryTargetSource, VaultCredentialSource,        embedded: SshConfigTargetSource, AgentCredentialSource,
        DbHostKeyStore, CidrAddressGuard, ControlPlaneAudit           KnownHostsStore, OrgDenyListGuard, LocalAuditLog
```

## 4. Parity test suite

`tests/parity/*.spec.ts` (Playwright) parametrized over projects:

```ts
// playwright.config.ts (excerpt)
projects: [
  { name: 'hosted',    use: { baseURL: process.env.HOSTED_URL,  storageState: 'auth/hosted.json' } },
  { name: 'local-web', use: { baseURL: 'http://localhost:3000' } },
  { name: 'desktop',   use: { /* launched via _electron.launch() fixture */ } },
]
```

Scenarios run in all three: open folder, edit & save, terminal echo, Ctrl+C, connect to test SSH
target (managed or personal fixture), remote edit/save, traversal denial, run pytest sample, view results.

CI runs `hosted` + `local-web` on every PR (compose), `desktop` nightly on Windows/macOS/Linux runners.

## 5. Local Web packaging

```bash
# single-user local web, current folder as workspace
docker run --rm -p 127.0.0.1:3000:3000 \
  -v "$PWD":/home/qe/project \
  -v "$HOME/.ssh":/home/qe/.ssh:ro \
  -e QE_MODE=local-web \
  registry.corp/qe-workspace/runtime-python:<version>
```
- Binds only to `127.0.0.1` by default (never `0.0.0.0` without auth).
- Startup prints a one-time URL token (like Jupyter) so other local users/processes cannot attach.
- `~/.ssh` mounted read-only; agent socket forwarding optional (`-v $SSH_AUTH_SOCK:/ssh-agent -e SSH_AUTH_SOCK=/ssh-agent`).

## 6. Desktop packaging
- `electron-builder` targets: Windows NSIS/MSI, macOS dmg (notarized), Linux AppImage/deb.
- Auto-update from an internal update server (optional; or distribute via software center).
- Managed settings (org policy) read from a machine-level file/registry key: control plane URL,
  extension registry URL, personal-target deny list, telemetry endpoint.
- Tokens stored with Electron `safeStorage`/OS keychain; never in plain JSON.

## 7. VS Code users' migration path
- Workspace template = devcontainer-like spec (`.qe-workspace/template.json`) — optionally import from
  existing `.devcontainer/devcontainer.json` (image, extensions, postCreateCommand).
- Keybindings and settings JSON compatible; `settings.json` keys used by VS Code extensions work.
- Same extensions from Open VSX (verify availability of each required extension in Phase 00; some
  Microsoft-proprietary extensions are not on Open VSX — e.g. Pylance; use open alternatives such as
  basedpyright/Pyright-based or Jedi language servers).
