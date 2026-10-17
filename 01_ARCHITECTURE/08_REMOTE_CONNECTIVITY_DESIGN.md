# 08 — Remote Connectivity Design ("connect to other systems")

This document details how QE Workspace connects to other machines — lab VMs, physical test hosts,
DUTs, Windows servers — safely, in **all three modes**.

## 1. Connection types

| Type | Available in | Registered by | Credentials | Broker |
|---|---|---|---|---|
| **Managed target** | Hosted Web, Local Web (signed-in), Desktop (signed-in) | Admin in control plane | Vault (SSH cert / key / password) | Hosted broker |
| **Personal target** | Desktop, Local Web (single-user) | User (from `~/.ssh/config` or UI) | User's ssh-agent / key files on their machine | Embedded broker |
| **Jump-host chained** | Any of the above | Admin (managed) / `ProxyJump` (personal) | Per hop | Same broker |

Hosted mode **never** offers personal targets: the hosted broker must not become a generic SSH proxy.

## 2. Capabilities per connection

| Capability | Default | Description |
|---|---|---|
| `terminal` | on | Interactive PTY shell |
| `file_read` | on | SFTP stat/list/read under `remoteRoot` |
| `file_write` | policy | SFTP write/mkdir/rename/delete under `remoteRoot` |
| `exec` | policy | Run a structured command (used by QE runner on remote) |
| `port_forward` | **off** | Local→remote TCP forwarding to allowlisted destinations (Phase 19) |

## 3. Managed target lifecycle

```text
Admin creates target (status=pending_host_key)
   │
   ├─► SSRF validation of host (resolve → CIDR allowlist → deny lists)
   ├─► Host-key enrollment:
   │      a) admin pastes known fingerprint from CMDB/console  (preferred)  or
   │      b) "scan" → broker connects, returns presented keys, admin compares out-of-band and approves
   │      c) host certificate signed by trusted host CA → no per-host pinning needed
   ├─► Credential reference set (SSH CA role / Vault KV path)
   ├─► Test connection (admin) → audit
   └─► status=active → visible to users allowed by policy
```

## 4. Connect sequence (managed, hosted broker)

```text
 1. UI lists targets: GET /targets (policy-filtered)
 2. User clicks Connect → POST /targets/{id}/sessions {kind}
 3. Control plane: authn, authz, policy (roles, capability, per-user session cap), rate limit
 4. Session row (AUTHORIZED) + ticket (hash stored) + audit REMOTE_CONNECT_ALLOWED
 5. Frontend opens WSS (terminal) or uses REST fs ops (files) with ticket/session
 6. Broker redeems ticket → gets frozen snapshot of target + policy (version-stamped)
 7. SSRF guard: dns.lookup(host, {all:true}) → every address must be in allowed_cidrs and not in deny list
    → choose first allowed address → connect by IP (servername/host-key check uses target record)
 8. Credentials:
      ssh_certificate: generate ephemeral ed25519 keypair in memory → Vault ssh/sign/<role>
                       with valid_principals=<mapped principal>, ttl=10m → cert
      vault_key:       read private key from Vault KV (cache ≤ 60 s in memory, zeroize buffer after use)
      vault_password:  read password (keyboard-interactive/password auth)
 9. ssh2 Client.connect({ host: ip, port, username: principal, privateKey, (cert via agent shim),
       hostVerifier: (key) => verifier.verify(target, key), algorithms: hardened, readyTimeout: 10000 })
10. hostVerifier: compute SHA256 fingerprint of presented key →
       trusted record match → true
       host cert signed by trusted host CA & principal matches host → true
       otherwise → false + SSH_HOST_KEY_MISMATCH/UNKNOWN audit + security metric
11. Channel: shell({ term:'xterm-256color', cols, rows }) | sftp() | exec(argv)
12. Session ACTIVE → stream → idle/absolute timers → close → audit SSH_SESSION_CLOSED
```

> **Certificate auth with ssh2:** confirm in the Phase 00 spike how the pinned `ssh2` version accepts
> OpenSSH user certificates (some versions need an agent implementation that returns the cert as the
> identity). If unsupported, implement a tiny in-memory `BaseAgent` that serves `{key, cert}` — record
> the result in an ADR. Fallback is `vault_key` until resolved.

## 5. Principal mapping

| Mode | Principal |
|---|---|
| Per-user accounts on targets | `principalTemplate = '{{user.username}}'` → target has a Unix account per engineer (best audit) |
| Shared service account | `principalTemplate = 'qeauto'` → target logs show `qeauto`; **our audit** identifies the human |

Prefer per-user principals with SSH certificates — the target's own `auth.log` then names the human.

## 6. Host-key trust models

| Model | How | When |
|---|---|---|
| Pinned fingerprints | `target_host_keys` rows approved by admin | Small/medium labs |
| Host CA | Targets have host certs signed by org host CA; broker trusts CA public key | Large fleets; automatic rotation |
| CMDB import | Sync job imports fingerprints from CMDB/inventory | When inventory is authoritative |

Rules: **never** trust-on-first-use automatically in hosted mode. Key rotation = admin approves new key,
revokes old one. Mismatch = fail closed + alert.

## 7. Jump hosts / bastions

```ts
// broker-core: connect through a jump host using ssh2 forwardOut + sock
const jump = await transport.connect(jumpTarget, jumpCreds);
const stream = await jump.forwardOut('127.0.0.1', 0, finalTargetIp, finalTarget.port);
const final = await transport.connect(finalTarget, creds, { sock: stream });
```
- Both hops undergo policy, SSRF (final IP validated against final target's policy), and host-key checks.
- Chain depth ≤ 2 by default.

## 8. Remote filesystem semantics

- URI scheme `qe-ssh://{targetId}/{relativePath}` in Theia.
- All paths relative to `remoteRoot`; resolution algorithm:

```ts
export function confine(remoteRoot: string, requested: string): string {
  if (requested.includes('\0')) throw new DomainError('PATH_OUTSIDE_ROOT');
  if (requested.startsWith('/') || /^[a-zA-Z]:/.test(requested)) throw new DomainError('PATH_OUTSIDE_ROOT');
  const decoded = requested.replace(/\\/g, '/');
  const joined = path.posix.normalize(path.posix.join(remoteRoot, decoded));
  if (joined !== remoteRoot && !joined.startsWith(remoteRoot.endsWith('/') ? remoteRoot : remoteRoot + '/'))
    throw new DomainError('PATH_OUTSIDE_ROOT');
  return joined;
}
// THEN on the server side: sftp.realpath(joined) must also start with realpath(remoteRoot)
// (catches symlinks). For writes to new files, realpath the parent directory.
```
- Limits: read ≤ 10 MB, list ≤ 5,000 entries (truncated flag), op timeout 15 s.
- Conflict detection: ETag = `${mtimeMs}-${size}`; write with `ifMatch` → 409 on mismatch; UI offers
  compare/overwrite.
- File watching: polling of open editors' files and expanded directories (configurable interval, e.g.
  5 s) rather than remote inotify agents in v1.
- Atomic save: write to `.<name>.qews-tmp-<rand>` then `rename` (posix-rename extension when supported).

## 9. Windows targets
- Requires OpenSSH Server on Windows; default shell configurable (`powershell.exe`/`pwsh`/`cmd`).
- SFTP paths: Windows OpenSSH exposes `/C:/Users/...`; set `remoteRoot` accordingly; confinement logic
  normalizes drive-letter form.
- PTY: ConPTY-backed on server; test resize and Ctrl+C behaviour explicitly.

## 10. Embedded broker (desktop / local web personal targets)

- Same `broker-core` package, configured with:
  - `TargetSource = SshConfigTargetSource` (parses `~/.ssh/config` with `ssh-config` package: Host, HostName, User, Port, IdentityFile, ProxyJump)
  - `CredentialSource = AgentCredentialSource` (`SSH_AUTH_SOCK`, Windows `\\.\pipe\openssh-ssh-agent`, or Pageant) with fallback to IdentityFile + passphrase prompt in UI (passphrase never persisted)
  - `HostKeyStore = KnownHostsStore` (`~/.ssh/known_hosts`, honours hashed entries); unknown key → **UI prompt** with fingerprint (user's own machine → TOFU allowed, like OpenSSH `ask`), mismatch → hard fail with OpenSSH-style warning.
- No SSRF guard needed for personal targets (user's own network position), but org policy can supply a
  deny list (e.g. production CIDRs) via desktop managed settings.

## 11. Session governance
- Idle timeout (no input/output) default 30 min; absolute 8 h; both from policy.
- Revocation: control plane marks REVOKED → calls broker `:close` → WS close 4011.
- Per-user cap (e.g. 5 concurrent), per-target cap (e.g. 50).
- Optional **session recording** (asciicast v2) to object storage, off by default, policy-driven, with
  user notice banner — requires privacy/legal approval.

## 12. Future protocols (not in v1)
- RDP/VNC via Apache Guacamole behind the same policy/ticket model.
- Serial console servers via SSH to console server (works today as a normal target).
- "Remote agent" mode: run a Theia backend on the target over SSH for full language-server support
  on remote code (Phase 19).
