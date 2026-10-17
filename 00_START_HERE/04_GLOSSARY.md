# 04 — Glossary

| Term | Meaning in this kit |
|---|---|
| **QE Workspace** | The product being built. |
| **Mode** | How the product is run: *Hosted Web*, *Local Web*, *Desktop*. |
| **Workspace** | A logical project environment: settings, membership, a project root, and a runtime binding. Persisted. |
| **Workspace runtime** | The isolated compute that runs a workspace's Theia backend, terminals, language servers and tests (a K8s pod, a Docker container, or the local machine in desktop mode). |
| **Control plane** | The API service that owns identity mapping, RBAC, workspaces, targets, policies, sessions and audit. Never runs user code. |
| **Gateway / workspace router** | Component that authenticates browser traffic and routes `/w/{workspaceId}/…` (HTTP + WebSocket) to the right runtime. |
| **Connection broker** | Service that owns outbound SSH: policy re-check, credential resolution, host-key verification, PTY/exec/SFTP channels. |
| **Embedded broker** | The same broker library running inside the local backend (desktop / local web) for personal targets. |
| **Target / Remote target** | A registered remote system (host, port, username/principal mapping, host-key record, policy). |
| **Personal target** | (Desktop/local only) a host from the user's own `~/.ssh/config`, not centrally registered. |
| **Connection policy** | Rules for who may connect to which targets, with which capabilities (terminal, file read/write, exec, port forward). |
| **Capability** | A fine-grained permission like `remote:file_write`, `terminal:open`, `qe_test:execute`. |
| **Session** | A server-side record of an active terminal/SSH/file session with state, owner, expiry. |
| **Session ticket** | Single-use, short-lived (≤60 s) token that authorizes opening one WebSocket for one session. |
| **Host-key verification** | Checking the remote server's SSH host key against a trusted record before sending credentials. |
| **SSH certificate** | A user public key signed by a CA (e.g. Vault SSH engine) with short TTL and principals; replaces long-lived keys. |
| **SSRF** | Server-Side Request Forgery: tricking the backend into connecting to a forbidden internal address. |
| **Remote root** | The directory on a target that remote file operations are confined to. |
| **Theia extension** | Build-time TypeScript module (InversifyJS DI) that extends the IDE frontend and/or backend. |
| **VS Code extension / plugin** | A `.vsix` loaded at runtime via Theia's plugin system (from an Open VSX registry). |
| **Open VSX** | Vendor-neutral VS Code extension registry; run an internal mirror for enterprise use. |
| **PTY** | Pseudo-terminal; lets interactive programs behave as if attached to a real terminal. |
| **OIDC** | OpenID Connect; SSO protocol used for login. |
| **PKCE** | Proof Key for Code Exchange; secures OAuth flows for public clients (desktop app). |
| **PSS** | Kubernetes Pod Security Standards (Privileged / Baseline / Restricted). |
| **SBOM** | Software Bill of Materials. |
| **Phase gate** | The evidence record that a phase meets its exit criteria. |
| **M1…M5** | Demo milestones (see README). |
