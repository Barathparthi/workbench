# Spike S4 — `ssh2` deep-check

**Date:** 2026-10-17 · **Phase:** 00, step 0.7 · **Code:** [`spikes/s4-ssh2/`](../../spikes/s4-ssh2/) · **Informs:**
ADR-002 (brokered SSH), ADR-007 (short-lived certificates), `packages/broker-core` · **Environment:** Linux x64
container, Node 24.22.0, `ssh2` 1.17.0 (latest, 2025-08-20, pure JS), OpenSSH 9.6p1 target and bastion, Vault
2.2.0 dev server with the SSH secrets engine as user CA (ed25519)

## Question

Can the broker build on `ssh2` for fail-closed host-key verification, short-lived certificate logins, agents,
jump hosts, interactive PTYs and SFTP, and what must our wrapper (`SshTransport`) add?

## Result

**Yes, with one five-line patch.** 20 checks against real OpenSSH servers: 19 pass on stock `ssh2`, and all
20 pass, twice in a row, once the certificate patch is applied.

| # | Check | Result |
| --- | --- | --- |
| 1 | SHA256 fingerprint we compute from the presented key equals `ssh-keygen -l -E sha256` | ✔ `SHA256:sQ+3uKiW…p8RsY` both |
| 2 | **No `hostVerifier` → ssh2 accepts any host key** ("Host accepted by default (no verification)") | ⚠ documented; must never happen in our code |
| 3 | Wrong pin → `Host denied (verification failed)`, level `handshake`, **no `SERVICE_REQUEST`/`USERAUTH_REQUEST` sent** | ✔ fails closed before credentials |
| 4 | Callback (async) verifier, 150 ms "lookup" → connection waits, then authenticates | ✔ |
| 5 | Negotiated with OpenSSH 9.6: `curve25519-sha256@libssh.org`, host key `ssh-ed25519`, cipher `aes128-gcm@openssh.com` | ✔ |
| 6 | **Vault-signed ed25519 user certificate** (the key itself is not in `authorized_keys`) | ✘ stock · ✔ **patched** |
| 7 | Ephemeral key without its certificate → rejected | ✔ |
| 8 | Certificate for principal `otheruser` → cannot log in as `qeuser` | ✔ rejected |
| 9 | 5-second certificate, used after expiry → rejected | ✔ |
| 10 | Key held in `ssh-agent` (`SSH_AUTH_SOCK`) | ✔ |
| 11 | Certificate held in `ssh-agent` | ✘ not used by ssh2 (informational) |
| 12 | Jump host: bastion (pinned) → `forwardOut` → target (pinned separately) over the tunnel | ✔ two different fingerprints verified |
| 13 | Bastion `PermitOpen 127.0.0.1:2222` → forwarding to `:22` refused | ✔ `Channel open failure` |
| 14 | Target `AllowTcpForwarding no` → `forwardOut` refused | ✔ |
| 15 | PTY opened at 24×80 → `stty size` = `24 80`; `setWindow(40,120)` → `40 120` | ✔ |
| 16 | Interrupting a foreground `sleep 30`: **`\x03` through the PTY → 26 ms, exit 130**; SSH `signal('INT')` → **not interrupted** | ✔ Ctrl+C works, signal does not |
| 17 | Closed port → `ECONNREFUSED`, level `client-socket`, 1 ms | ✔ |
| 18 | TCP accepted but no SSH banner → `Timed out while waiting for handshake`, level `client-timeout`, 2.0 s | ✔ |
| 19 | Unauthorized key → `All configured authentication methods failed`, level `client-authentication` | ✔ |
| 20 | SFTP: `realpath`, write, read back, `stat`, `unlink` in `/home/qeuser` | ✔ |

sshd's own log for check 6 (patched): `Accepted certificate ID "vault-token-…" (serial …) signed by ED25519 CA
SHA256:sjt1u0LR… via …/vault_user_ca.pub` → `Accepted publickey for qeuser … ED25519-CERT …`.

## Findings

### 1. `ssh2` fails open without a verifier → `SshTransport` must make it mandatory

With no `hostVerifier`, `ssh2` connects to any server. The wrapper in `packages/broker-core` must refuse to
build a connection config without one, and a test must assert that. The verifier compares the OpenSSH-style
`SHA256:` fingerprint (base64 of SHA-256 over the raw key blob, no padding; matches `ssh-keygen`). It may be
asynchronous (policy/DB lookup), and on mismatch the connection ends during key exchange, before any credential
leaves the broker. The verifier knows *why* it rejected, so the broker can emit `HOST_KEY_UNKNOWN` (no record)
vs `HOST_KEY_MISMATCH` (record differs, security audit event) — `ssh2` itself reports both as
`Host denied (verification failed)`.

### 2. User certificates need a patch (risk R3 materialised)

`ssh2` 1.17.0 has no OpenSSH certificate support. Public-key auth works with any object that has `type`,
`getPublicSSH()` and `sign()`, so the broker can present the certificate blob and
`ssh-ed25519-cert-v01@openssh.com` while signing with the private key. But `Protocol.authPK()` then writes the
**certificate** algorithm name into the signature blob (and skips `convertSignature` for ECDSA), and OpenSSH
rejects the signature. RFC 4252 / OpenSSH `PROTOCOL.certkeys` require the underlying key's format
(`ssh-ed25519`). [`patch-ssh2-certificates.mjs`](../../spikes/s4-ssh2/patch-ssh2-certificates.mjs) strips
`-cert-v01@openssh.com` for the signature only (5 lines); with it, Vault certificates work and wrong-principal
and expired certificates are still rejected by the server.

Options for production (Phase 08/12): carry the patch with `patch-package` and submit it upstream; pin `ssh2`
exactly and cover it with an integration test (Testcontainers OpenSSH + Vault) so an upgrade cannot silently drop
it. Fallback that needs no patch: ADR-007's `vault_key` mode (per-target key stored in Vault).

### 3. Agents: keys yes, certificates no

`ssh2` agent auth works for plain keys (Linux socket tested). It does not use certificates held in an agent, so
the broker should keep the ephemeral key **in memory** and sign it per session (the ADR-007 design) rather than
going through an agent. Desktop personal targets (`~/.ssh/config`, org decision C9) can use the user's agent for
plain keys. The Windows OpenSSH agent pipe (`\\.\pipe\openssh-ssh-agent`) and Pageant **were not tested** here;
`ssh2` lists both. Test them on the Windows desktop CI in Phase 10.

### 4. Ctrl+C must travel through the PTY

The SSH `signal` channel request reaches the session process (the shell), not the foreground job, so `sleep`
kept running. Writing `\x03` lets the remote PTY deliver SIGINT to the foreground process group (26 ms). The
`qews.v1` protocol's interrupt maps to writing `\x03`, as the kit already suggests.

### 5. Jump hosts

`forwardOut` on the bastion plus `sock:` for the target works, and each hop gets its own pinned fingerprint.
Bastion-side `PermitOpen` is an effective second fence beside our policy engine. Forwarding stayed off on the
target (rule 5).

### 6. Error mapping for `packages/broker-core`

| `ssh2` error | Level / code | `ErrorCode` |
| --- | --- | --- |
| `Host denied (verification failed)` | `handshake` | `HOST_KEY_UNKNOWN` or `HOST_KEY_MISMATCH` (decided by our verifier) |
| `All configured authentication methods failed` | `client-authentication` | `CREDENTIALS_REJECTED` |
| `Timed out while waiting for handshake` | `client-timeout` | `SSH_TIMEOUT` |
| `connect ECONNREFUSED …` (also `EHOSTUNREACH`, `ENETUNREACH`) | `client-socket` | `SSH_UNREACHABLE` |
| `(SSH) Channel open failure: open failed` on a jump hop | — | `TARGET_NOT_ALLOWED` (forwarding refused by the bastion) |

### 7. Other notes

- Pin the algorithm lists in `SshTransport` (kex, ciphers, host key types) rather than relying on `ssh2`
  defaults. The negotiated set above is modern.
- Vault's default certificate key ID is `vault-token-<hash>`, which sshd logs. Set the role's `key_id_format`
  to include the user identity (e.g. `{{token_display_name}}`) so target-side logs attribute sessions (Phase 12).
- Certificate TTL 15 min worked; sessions outlive the certificate because it is only checked at login.
- `ssh2`'s optional native crypto add-on was not built (npm `allowScripts` denied); pure JS was sufficient.

## Not covered

- Windows/macOS agents (Phase 10), Vault auth methods other than a root dev token (Phase 12), host
  certificates / SSH host CA (org decision C4, later), RSA/ECDSA certificates (the patch handles their names
  but only ed25519 was run), throughput and many concurrent sessions (Phase 17).
