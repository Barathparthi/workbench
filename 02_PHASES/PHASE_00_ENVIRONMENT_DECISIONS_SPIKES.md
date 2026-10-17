# Phase 00 — Environment, Decisions and Technical Spikes

| | |
|---|---|
| **Goal** | Capture org inputs, pin the toolchain, and remove the biggest technical unknowns *before* building |
| **Duration** | 1–1.5 weeks |
| **Team** | Tech lead, 1–2 engineers, platform + security contact |
| **Prerequisites** | Sponsor approval, access to a Linux test VM, Docker on dev machines |
| **Prompt pack** | `03_PROMPTS/PHASE_00_PROMPTS.md` |

## Deliverables
1. `docs/ORG_DECISIONS.md` (filled `00_START_HERE/03_DECISIONS_BEFORE_CODING.md`).
2. Pinned versions table with verification date.
3. Spike reports (throwaway code in `spikes/`, **not** merged into product code):
   - S1 Theia browser + Electron hello app with our extension.
   - S2 Theia behind a reverse proxy under a base path `/w/{id}/`.
   - S3 Remote terminal + remote FS approach inside Theia.
   - S4 `ssh2`: host-key verification, certificate auth, agent on Windows/macOS/Linux, jump host.
   - S5 Open VSX: availability of required VS Code extensions.
4. ADRs updated/created (`05_ADR/`) with spike outcomes.
5. Risk register initialised (`07_PLANNING/RISK_REGISTER.md`).

## Step-by-step

### Step 0.1 — Kick-off and scope freeze (day 1)
1. Walk the sponsor through `00_START_HERE/01_EXECUTIVE_SUMMARY.md`.
2. Confirm modes for GA (hosted/local-web/desktop) and the first test framework.
3. Record non-goals explicitly (open SSH proxy, port forwarding at GA, RDP).
4. Name owners: IDE platform, control plane, broker, runtime/infra, security, QE extension SDK.

### Step 0.2 — Collect org decisions (days 1–3)
1. Send sections B–E of the decisions sheet to IdP, platform, security, network teams.
2. Get **concrete** values: IdP issuer URL, test client registration, group names, lab CIDRs, Vault
   mount paths, registry URL, K8s cluster for dev.
3. Unknowns → risk register with an owner and a date.

### Step 0.3 — Pin the toolchain (day 2)
1. Check Theia's latest community release and its `engines.node` requirement.
2. Choose the Node **Active LTS** that satisfies it; record in `.nvmrc` draft.
3. Record Electron version implied by `@theia/electron`.
4. Record PostgreSQL major supported by your managed service.

### Step 0.4 — Spike S1: Theia hello (browser + Electron) (days 2–3)
1. Generate a Theia app/extension (official generator: `npx yo theia-extension` — check current docs, or
   copy the Theia "theia-ide" / example app layout).
2. Create one extension `qe-hello` with a command `qe.hello` that shows a message.
3. Build browser target: `npm run build:browser && npm run start:browser` → open `http://localhost:3000`.
4. Build Electron target: `npm run build:electron && npm run start:electron`.
5. Verify the same command appears in both. Measure build times and bundle size.
6. Note native module rebuild steps for Electron on Windows (node-pty).

### Step 0.5 — Spike S2: base path / reverse proxy (day 3–4)
1. Put NGINX (or a 30-line Fastify proxy with `@fastify/http-proxy`, `websocket: true`) in front of
   the browser app at `/w/test-ws/`.
2. Confirm: static assets load, Theia's WebSocket connects, terminal works, webviews render.
3. If Theia doesn't support a base path natively for your version, decide: **path-based** routing
   with rewrite, or **subdomain-per-workspace** (`{id}.ws.qe-workspace.corp`, wildcard TLS cert).
   Record ADR-005.

### Step 0.6 — Spike S3: remote terminal + remote FS in Theia (days 4–6)
Prototype each option for 2–4 hours, choose one, record ADR-006:
- **Option A (recommended to try first):** built-in VS Code-API plugin that uses
  `window.createTerminal({ name, pty })` with a `Pseudoterminal` that connects to the broker WS;
  `workspace.registerFileSystemProvider('qe-ssh', provider)` for files.
  *Pros:* stable public API, same in browser & Electron. *Cons:* plugin host runs in backend
  (runtime) → in hosted mode, the plugin would reach the broker from the runtime (violates P9 unless
  the connection is proxied via the frontend). Check whether your Theia version supports running such
  a plugin in the *frontend* (web extension host / `browser` entry in plugin `package.json`).
- **Option B:** Theia frontend extension: custom terminal widget using Theia's `TerminalWidget`
  / xterm.js connected directly to broker WS from the frontend; `FileSystemProvider` registered in the
  frontend `FileService` via `FileServiceContribution`.
  *Pros:* keeps credentials/egress out of runtime (P9), full control. *Cons:* uses Theia internal APIs
  that may change between versions.
- **Option C:** standalone xterm.js widget (fallback).

Decision criteria: P9 compliance, parity across browser/Electron, effort, upgrade risk.

### Step 0.7 — Spike S4: ssh2 deep-check (days 4–6)
1. Start a test sshd in Docker with a known ed25519 host key.
2. Implement `hostVerifier` computing `SHA256:` fingerprint (Node `crypto.createHash('sha256')` of the
   raw key blob, base64 without padding) — compare with `ssh-keygen -lf`.
3. Try certificate auth: Vault dev server with SSH engine → sign ephemeral key → connect.
4. Agent auth on Windows (`\\.\pipe\openssh-ssh-agent`) and macOS/Linux (`SSH_AUTH_SOCK`).
5. Jump host using `forwardOut` + `sock`.
6. PTY resize (`setWindow`) and SIGINT (send `\x03` vs `channel.signal('INT')` — many servers ignore
   SSH signal requests; `\x03` through the PTY is the reliable way).
7. Record results in ADR-002 addendum.

### Step 0.8 — Spike S5: extensions (day 5)
1. List required extensions (A8). Check each on open-vsx.org (or your mirror).
2. For missing ones, choose alternatives and note it in `docs/ORG_DECISIONS.md`.

### Step 0.9 — Plan & estimates (day 6–7)
1. Update `07_PLANNING/ROADMAP_AND_TIMELINE.md` with spike learnings.
2. Hold a 1-hour architecture review: architecture doc + ADRs + risks.

## Exit criteria (phase gate)
- [ ] Decisions sheet ≥ 90% filled; remaining items have owners/dates.
- [ ] Versions pinned and recorded.
- [ ] S1–S5 reports written; ADR-005 (routing), ADR-006 (remote terminal/FS approach) accepted.
- [ ] Architecture review held; sign-off from tech lead + security.

## Pitfalls
- Building production code inside spikes → keep `spikes/` out of the product tree.
- Assuming VS Code Marketplace extensions are available in Theia — licence terms restrict the MS marketplace; use Open VSX.
- Ignoring Windows desktop native-module builds until late.
