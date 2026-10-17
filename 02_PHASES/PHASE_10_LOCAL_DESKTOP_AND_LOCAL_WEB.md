# Phase 10 — Local Desktop and Local Web Mode

| | |
|---|---|
| **Goal** | The same product works **locally** — as a desktop app and as single-user local web — with personal and managed remote connections |
| **Duration** | 2 weeks |
| **Prerequisites** | Phases 02, 08, 09 |
| **Prompt pack** | `03_PROMPTS/PHASE_10_PROMPTS.md` |

## Deliverables
- Embedded broker (desktop backend + local-web backend) using `broker-core`.
- `SshConfigTargetSource`, `AgentCredentialSource`, `KnownHostsStore`, `OrgDenyListGuard`.
- Desktop OIDC sign-in (system browser + PKCE + loopback) for managed targets; tokens in OS keychain.
- `CompositeConnectionClient` merging managed + personal targets.
- Local-web container profile (localhost-only, one-time URL token).
- Signed installers for Windows/macOS/Linux; managed settings file.
- Parity test suite running in all three modes.

## Step-by-step

### 10.1 Embedded broker service (backend contribution)
- Theia backend module (`backendElectron` and `backend` when `QE_MODE=local-web`) exposing `EmbeddedBrokerService` over Theia RPC: `listPersonalTargets`, `openTerminal`, `fs*`, `close`.
- Terminal stream carried over the Theia RPC/WS channel using the **same qews.v1 message types**.

### 10.2 Personal targets from `~/.ssh/config`
- Parse with `ssh-config` package: `Host` (skip wildcard-only entries), `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`.
- Show under "Personal" group; allow "Add host…" UI that appends to a QE-owned file (`~/.qe-workspace/ssh_hosts`), never edits the user's ssh config silently.

### 10.3 Credentials (user's machine)
- Agent first: Linux/macOS `SSH_AUTH_SOCK`; Windows `\\.\pipe\openssh-ssh-agent`, fallback `pageant`.
- Then `IdentityFile` keys; encrypted key → passphrase prompt (Theia input dialog), held in memory only for the connection.
- Never upload personal keys to the control plane.

### 10.4 Host keys (user's machine)
- Read `~/.ssh/known_hosts` (hashed and plain entries, `@cert-authority`, `@revoked`).
- Unknown → modal showing algorithm + SHA256 fingerprint: "Trust once / Trust and save / Cancel" (saved to `~/.qe-workspace/known_hosts` by default; optional write to `~/.ssh/known_hosts`).
- Mismatch → hard error with OpenSSH-style warning; no override button in v1.
- Org managed setting can disable TOFU entirely.

### 10.5 Managed targets from desktop
- "Sign in to QE Workspace" → `openid-client` auth code + PKCE with loopback redirect `http://127.0.0.1:<random>/callback` (RFC 8252), system browser.
- Store refresh token with Electron `safeStorage` (or keytar); access token in memory.
- Use bearer tokens to call the hosted control plane/broker; same ticket flow as browser.

### 10.6 Local web mode
- `QE_MODE=local-web`; backend binds `127.0.0.1` only (container publishes `127.0.0.1:3000`).
- On start, generate one-time token; print `http://127.0.0.1:3000/?token=…`; exchange for an HttpOnly cookie; reject requests without it.
- Volumes: project folder; `~/.ssh` read-only; optional agent socket.
- Provide `deploy/compose/docker-compose.local-web.yml` and a `qe-workspace-local` launcher script (bash + PowerShell).

### 10.7 Desktop packaging & managed settings
- `electron-builder`: Windows (NSIS/MSI, signed), macOS (dmg, notarized), Linux (AppImage/deb).
- Managed settings: Windows `HKLM\Software\Policies\QEWorkspace`, macOS `/Library/Application Support/QEWorkspace/policy.json`, Linux `/etc/qe-workspace/policy.json` → control plane URL, Open VSX URL, deny CIDRs, TOFU allowed, telemetry.
- Auto-update channel or software-center distribution.

### 10.8 Parity suite
`tests/parity/*` (see `01_ARCHITECTURE/09_LOCAL_AND_WEB_PARITY.md` §4) run in hosted, local-web (CI on PR) and desktop (nightly on 3 OSes).

## Tests
- Unit: ssh-config parsing, known_hosts matching (hashed, wildcard, cert-authority, revoked).
- Integration: embedded broker vs OpenSSH container with agent auth (ssh-agent container) and key-file auth.
- Security: desktop refresh token not in plaintext files; local-web rejects requests without token cookie; local-web not reachable on non-loopback interface.
- Parity: all scenarios green in three modes.

## Exit criteria
- [ ] Desktop app on Windows/macOS/Linux: open folder, terminal, personal SSH target, managed SSH target (signed in), remote edit.
- [ ] Local-web container: same, localhost-only.
- [ ] Parity suite green.
