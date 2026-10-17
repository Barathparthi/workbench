# Phase 08 — SSH Connection Broker and Remote Terminal

| | |
|---|---|
| **Goal** | **Connect to other systems**: a permitted user opens an interactive SSH terminal on an approved target from the IDE |
| **Duration** | 2 weeks |
| **Prerequisites** | Phase 07; ADR-002, ADR-006 |
| **Prompt pack** | `03_PROMPTS/PHASE_08_PROMPTS.md` |

## Deliverables
- `packages/broker-core`: `SshTransport` (ssh2 adapter), `HostKeyVerifier`, `CredentialSource`, `SessionRegistry`, `TerminalBridge` (qews.v1), limits.
- `apps/connection-broker`: WS endpoint `/api/v1/sessions/{id}/stream`, internal close API, health, metrics.
- Dev `CredentialSource` (file-based, dev only) — Vault arrives in Phase 12.
- Remote terminal in Theia (approach per ADR-006).
- Integration tests against OpenSSH containers.

## Step-by-step

### 8.1 Interfaces
```ts
export interface SshEndpoint { address: string; port: number; username: string; hostKeyPolicy: HostKeyPolicy }
export interface SshCredential { kind: 'key' | 'cert' | 'password' | 'agent'; /* material held in memory only */ }
export interface SshConnection {
  shell(opts: { cols: number; rows: number; term: string }): Promise<PtyChannel>;
  exec(argv: readonly string[], opts?: { timeoutMs?: number }): Promise<ExecChannel>;
  sftp(): Promise<SftpHandle>;
  forwardOut(dstHost: string, dstPort: number): Promise<Duplex>;   // jump hosts only
  close(): void;
  onClose(cb: (reason: string) => void): void;
}
export interface SshTransport {
  connect(ep: SshEndpoint, cred: SshCredential, opts?: { sock?: Duplex; signal?: AbortSignal }): Promise<SshConnection>;
}
```

### 8.2 ssh2 adapter essentials
```ts
const client = new Client();
client.connect({
  host: ep.address, port: ep.port, username: ep.username,
  sock: opts?.sock,
  privateKey: cred.privateKey,                  // Buffer; zero-fill after 'ready'
  readyTimeout: 10_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
  algorithms: {
    serverHostKey: ['ssh-ed25519','ecdsa-sha2-nistp256','rsa-sha2-512','rsa-sha2-256'],
    kex: ['curve25519-sha256','curve25519-sha256@libssh.org','ecdh-sha2-nistp256'],
    cipher: ['aes256-gcm@openssh.com','aes128-gcm@openssh.com','chacha20-poly1305@openssh.com'],
  },
  hostVerifier: (key: Buffer) => verifier.verify(ep.hostKeyPolicy, key),   // MUST return false on doubt
});
client.on('tcp connection', (_info, _accept, reject) => reject());       // no remote-initiated forwards
```
- Fingerprint: `'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/,'')`.
- Verify algorithm names against your pinned ssh2 version.
- Map errors: `ECONNREFUSED/EHOSTUNREACH` → `SSH_UNREACHABLE`; timeout → `SSH_TIMEOUT`; auth → `CREDENTIALS_REJECTED`; verifier false → `HOST_KEY_MISMATCH`/`HOST_KEY_UNKNOWN`.

### 8.3 Broker stream handler (sequence)
1. WS upgrade: check Origin; extract `ticket.<x>` subprotocol; select `qews.v1`.
2. Redeem ticket (internal API) → snapshot {user, target, policy, capabilities}.
3. AddressGuard re-check → pinned IP.
4. Credentials from `CredentialSource` (dev: file; prod: Vault).
5. `transport.connect` (+ jump host if configured) → `shell({cols, rows, term:'xterm-256color'})`.
6. Report ACTIVE to control plane; audit `SSH_SESSION_OPENED`; send `{t:"hostkey", …, verified:true}` and `{t:"status",state:"ACTIVE"}`.
7. Bridge: binary `0x00` input → `channel.write`; channel data → binary `0x01` frames ≤ 32 KiB; `resize` → `channel.setWindow(rows, cols, 0, 0)`; `signal SIGINT` → write `\x03` (reliable) and try `channel.signal('INT')`.
8. Backpressure: pause channel when unacked > 1 MiB; resume on `ack`.
9. Timers: idle (no I/O) and absolute; on expiry close 4010 + `SESSION_EXPIRED`.
10. Close path (any cause) is idempotent: end channel → end client → registry remove → report CLOSED(reason) → audit `SSH_SESSION_CLOSED` with duration and bytes counts.

### 8.4 Session registry & revocation
- In-memory map `sessionId → {ws, conn, timers, userId}`; per-user and per-target counters.
- `POST /internal/v1/sessions/{id}:close` and `…/users/{id}:close-all` → close 4011.
- SIGTERM: stop accepting new; after grace, close with 4013.

### 8.5 Frontend remote terminal
- "Connect" on a target → `POST /targets/{id}/sessions {kind:'terminal'}` → open WS with ticket subprotocol → render in a Theia terminal widget (per ADR-006) titled `ssh: <target name>`.
- Show host-key fingerprint in the terminal header/tooltip; map close codes to friendly messages with a Reconnect action.
- Mirror sizing: on widget resize send debounced `resize` (100 ms).

### 8.6 Host-key scan (admin)
`connect` with a verifier that **records and rejects** the key → returns presented keys → admin approves in UI (Phase 07 flow).

### 8.7 Telemetry
Spans per `01_ARCHITECTURE/10_OBSERVABILITY.md` §3; metrics `qews.ssh.*`; never log keys, tickets, or bytes.

## Tests (OpenSSH containers via Testcontainers)
| Case | Expect |
|---|---|
| Happy path | `echo REMOTE_OK` output; `hostname` matches |
| Resize | `stty size` reflects new rows/cols |
| Ctrl+C | `sleep 100` interrupted |
| Host key mismatch (second container, different key) | `HOST_KEY_MISMATCH`, no auth attempted, audit + metric |
| Unknown host key | `HOST_KEY_UNKNOWN` |
| Wrong credential | `CREDENTIALS_REJECTED` |
| Unreachable / timeout | `SSH_UNREACHABLE` / `SSH_TIMEOUT` within limits |
| Ticket reuse / other user's ticket / bad Origin | close 4001, no TCP connection to target |
| Unauthorized user | 403 at session create; **no SYN** reaches sshd (assert server logs) |
| Remote host dies | close with reason; state FAILED/CLOSED; audit |
| Idle and absolute timeout | 4010 |
| Revoke | 4011 ≤ 10 s |
| Flood `yes` | broker memory bounded (backpressure) |

## Exit criteria
- [ ] **Milestone M2 (terminal half)**: browser → registered target → SSH terminal with all checks active.
- [ ] Every row above automated and green.
- [ ] No secret or ticket material in logs/traces (canary scan).
