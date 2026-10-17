# 07 — Security Architecture and Threat Model

QE Workspace is a **controlled remote-code-execution and remote-access platform**. Treat it like a
privileged access system, not a CRUD app.

## 1. Assets

| Asset | Sensitivity |
|---|---|
| SSH credentials / CA signing rights | Critical |
| Access to lab/production-adjacent systems | Critical |
| User sessions & OIDC tokens | High |
| Source code in workspaces | High (confidential) |
| Audit trail | High (integrity) |
| Workspace compute | Medium (abuse/cryptomining) |
| Test data & artifacts | Medium–High |

## 2. Trust boundaries

```text
TB1  Browser / desktop UI            ── untrusted input
TB2  Ingress → control plane          ── authenticated users
TB3  Control plane → DB/Vault         ── platform secrets
TB4  Router → workspace runtime       ── user-controlled code zone
TB5  Browser → broker stream           ── ticket-authenticated
TB6  Broker → remote targets          ── outbound privileged network
TB7  Desktop app → local OS           ── user's own permissions
TB8  CI/CD → registry → cluster       ── supply chain
```

## 3. STRIDE threat table

| # | Threat | Boundary | Control | Verification test |
|---|---|---|---|---|
| T1 | Session cookie theft/replay | TB1-2 | HttpOnly+Secure+SameSite cookies, short idle timeout, server-side session store, rotate on login, bind to UA hash (soft) | Replay after logout → 401 |
| T2 | CSRF on state-changing APIs | TB2 | Origin allowlist + double-submit CSRF token | Cross-origin POST → 403 |
| T3 | Broken access control (IDOR) | TB2 | Central authz middleware, resource-scoped checks, 404 for invisible | Generated authz matrix tests |
| T4 | Privilege escalation via role claims | TB2 | Role mapping from trusted IdP groups only; admin roles not self-assignable | Forged claim test with untrusted issuer |
| T5 | SSRF via target registration | TB6 | Admin-only registration, CIDR allowlist on **resolved** IP, deny loopback/link-local/metadata/cluster CIDRs, connect to pinned IP | Register `169.254.169.254`, `localhost`, DNS-rebinding name |
| T6 | DNS rebinding at connect time | TB6 | Resolve once in broker, validate, connect to that IP; re-validate on each connect | Test DNS server flipping answers |
| T7 | Host-key spoofing / MITM | TB6 | Mandatory host-key verification against trusted record/CA; fail closed; security event | Swap test server key → `HOST_KEY_MISMATCH` |
| T8 | SSH credential theft | TB3,TB6 | Vault; short-lived certs (≤15 min TTL); memory-only in broker; never logged; broker pods isolated | Log/telemetry leak scan; heap dump policy |
| T9 | Credential reuse from workspace runtime | TB4 | Runtimes have no Vault access, no broker internal API access, no lab egress | NetworkPolicy test from runtime pod |
| T10 | Path traversal / symlink escape on remote FS | TB5-6 | Normalize POSIX path, reject `..`/NUL/abs, `realpath` check under root before every op | Traversal corpus test |
| T11 | Command injection in runner/exec | TB2,TB6 | Structured argv, allowlisted frameworks, no shell concatenation; remote exec quoted via fixed wrapper | Inject `; rm -rf` in selector |
| T12 | WebSocket hijacking (CSWSH) | TB5 | Origin check, single-use ticket in subprotocol, bound to user+session | Cross-origin WS, reused ticket |
| T13 | Port-forward / pivoting abuse | TB6 | Disabled by default; broker rejects `tcpip-forward`/`direct-tcpip` requests unless policy allows | Forward attempt → denied + audit |
| T14 | Workspace-to-workspace lateral movement | TB4 | One pod per workspace, NetworkPolicy deny pod-to-pod, separate PVCs, no SA token automount | Curl from ws A to ws B |
| T15 | Container escape | TB4 | Non-root, no privilege escalation, drop ALL caps, seccomp RuntimeDefault, read-only root FS where possible, PSS Restricted, optional gVisor/Kata | Admission policy test |
| T16 | Resource exhaustion (fork bomb, huge output) | TB4-5 | CPU/mem limits, `pids` limit, ephemeral-storage limit, WS backpressure, rate limits | Fork bomb in test workspace |
| T17 | Secret leakage to logs/telemetry | all | Redaction lists, allowlisted audit metadata, log scanning in CI tests | Canary secret appears nowhere |
| T18 | Audit tampering | TB3 | Insert-only grants, hash chain, export to WORM storage | Attempt UPDATE as app role |
| T19 | Malicious VS Code extension | TB4/TB7 | Internal Open VSX mirror with allowlist; no public registry in hosted mode | Install non-allowlisted ext → blocked |
| T20 | Supply-chain compromise | TB8 | Lockfile, SCA, image scan, SBOM, signed images, admission verifies signatures | Unsigned image rejected |
| T21 | Open redirect in login `returnTo` | TB2 | Only relative same-origin paths | `returnTo=https://evil` → ignored |
| T22 | Desktop app token theft | TB7 | Tokens in OS keychain (`safeStorage`), PKCE, refresh rotation | Token not in plain files |
| T23 | Stale access after offboarding | TB2 | Session revalidation against IdP/user status every N min; revoke API; SCIM later | Disable user → sessions closed |

## 4. Control catalogue by layer

### 4.1 Identity & session
- OIDC auth code + PKCE; validate `iss`, `aud`, `exp`, `nonce`; JWKS caching with rotation.
- Server-side session (DB/Redis) → cookie holds random 256-bit ID only.
- Idle 30 min (UI), absolute 8 h (configurable); re-auth required after absolute expiry.
- Dev mock IdP **compiled/configured out** of production: startup fails if `AUTH_MODE=dev` and `NODE_ENV=production`.

### 4.2 Authorization
- Permission matrix in `packages/rbac` (data, not code branches). Example:

| Permission | qe.user | qe.lead | lab.X.user | qe.admin | auditor |
|---|---|---|---|---|---|
| workspace:create/read/start/stop (own) | ✔ | ✔ | | ✔ | |
| workspace:admin (members) | own | ✔ | | ✔ | |
| target:list (policy-filtered) | ✔ | ✔ | ✔ | ✔ | |
| remote:connect, terminal, file_read | | | ✔ (lab X) | ✔ | |
| remote:file_write, remote:execute | | | per policy | ✔ | |
| port_forward:use | | | per policy (off) | | |
| target:admin, policy:admin | | | | ✔ | |
| session:admin (revoke) | | | | ✔ | |
| audit:read/export | | | | ✔ | ✔ |
| qe_test:execute/cancel | ✔ | ✔ | | ✔ | |

- Effective permission on a target = role permission ∧ policy (`allowed_roles`) ∧ policy capability ∧ target `active`.

### 4.3 Network
- Ingress only on 443; HSTS; TLS 1.2+ (1.3 preferred).
- NetworkPolicies: default deny in all namespaces; explicit allows (see Phase 16).
- Broker is the **only** workload with egress to lab CIDRs on port 22 (and jump hosts).
- Runtimes: egress only to Git host, package mirrors, Open VSX mirror, DNS.

### 4.4 Headers (control plane & router)
`Content-Security-Policy` (frame-ancestors 'none'; script-src 'self' + Theia requirements — verify
Monaco/webview needs), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Permissions-Policy` minimal, `Cross-Origin-Opener-Policy: same-origin`.

### 4.5 Rate limits (per user unless noted)
| Endpoint | Limit |
|---|---|
| `/auth/*` | 20/min per IP |
| workspace start | 10/min |
| session open | 20/min, max concurrent per policy |
| WS connects | 30/min |
| file ops | 50/s burst 100 |
| test-run create | 30/min |

## 5. SSH-specific hardening (broker)
- Algorithms: prefer `ssh-ed25519`, `ecdsa-sha2-nistp256`, `rsa-sha2-512/256`; disable `ssh-rsa` (SHA-1), CBC ciphers, `diffie-hellman-group1/14-sha1`.
- `readyTimeout` 10 s; keepalive 15 s × 3.
- Reject server requests for agent forwarding, X11, and port forwarding unless policy allows.
- Never enable agent forwarding to targets from the hosted broker.
- Max channels per connection; max sessions per user/target.
- Certificates: TTL ≤ 15 min, `valid_principals` = mapped username, extensions `permit-pty` only (no
  `permit-port-forwarding`, no `permit-agent-forwarding`) unless policy explicitly grants.

## 6. Security gates before production
1. Threat model reviewed and signed by security.
2. All T1–T23 have controls with passing automated tests (or accepted residual risk with owner).
3. SAST/SCA/secret/image/IaC scans: no Critical/High open without exception record.
4. DAST (ZAP) baseline on staging: no High.
5. External or internal penetration test completed; findings triaged.
6. Incident response runbook for "credential compromise" and "host-key mismatch storm" approved.
