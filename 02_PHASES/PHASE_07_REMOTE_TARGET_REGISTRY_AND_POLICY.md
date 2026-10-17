# Phase 07 — Remote Target Registry and Connection Policy

| | |
|---|---|
| **Goal** | Admins register remote systems; the platform makes explicit allow/deny decisions **before** any network activity |
| **Duration** | 1 week |
| **Prerequisites** | Phase 04 |
| **Prompt pack** | `03_PROMPTS/PHASE_07_PROMPTS.md` |

## Deliverables
- Target, policy, host-key and credential-reference APIs (admin) and policy-filtered listing (users).
- `packages/policy`: `evaluateConnection()` and `AddressGuard` (SSRF).
- Session + ticket issuance (`POST /targets/{id}/sessions`) — returns ticket; broker arrives in Phase 08.
- Admin UI (`extensions/qe-admin`): targets, policies, host-key approval.
- Users' **Remote Connections** view (`extensions/qe-remote`) listing allowed targets.

## Step-by-step

### 7.1 Validation schemas
- `host`: FQDN (RFC 1123, ≤ 253 chars) or IP literal; reject URLs, userinfo, whitespace, `%` zone IDs.
- `port`: integer 1–65535 **and** ∈ policy `allowed_ports`.
- `remoteRoot`: absolute POSIX path (or `/C:/…` for Windows), normalized, no `..`, not `/`.
- `principalTemplate`: only `{{user.username}}` placeholder or `[a-z_][a-z0-9_-]{0,31}`.
- Credential fields **never** accept raw secrets — only an existing `credential_ref_id`.

### 7.2 AddressGuard (SSRF)
```ts
export interface AddressDecision { allowed: boolean; address?: string; reason?: string }
export async function checkTarget(host: string, policy: Policy, deny: DenyList): Promise<AddressDecision> {
  const addrs = isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true, verbatim: true });
  for (const { address } of addrs) {
    const ip = normalize(address);                 // unwrap ::ffff:x.x.x.x, reject odd encodings
    if (deny.contains(ip)) return { allowed: false, reason: 'DENYLIST' };   // loopback, link-local, metadata, cluster/pod/service CIDRs, control-plane nets
    if (!policy.allowedCidrs.some(c => c.contains(ip))) return { allowed: false, reason: 'NOT_IN_ALLOWED_CIDR' };
  }
  return { allowed: true, address: normalize(addrs[0]!.address) };  // caller connects to THIS ip
}
```
- **All** resolved addresses must pass (prevents mixed answers).
- Run at registration (admin feedback) **and** at every connect (broker, Phase 08).
- Use `ipaddr.js` for parsing/CIDR matching; unit-test odd forms (`2130706433`, `0x7f.1`, `::ffff:127.0.0.1`).

### 7.3 Policy evaluation
```ts
export function evaluateConnection(p: Principal, t: Target, pol: Policy, kind: SessionKind, activeCount: number): Decision {
  if (t.status !== 'active') return deny('TARGET_NOT_ALLOWED', 'target_inactive');
  if (!p.permissions.has('remote:connect')) return deny('FORBIDDEN', 'no_remote_connect');
  if (!pol.allowedRoles.some(r => p.roles.includes(r))) return deny('TARGET_NOT_ALLOWED', 'role');
  const cap = kind === 'terminal' ? 'terminal' : kind === 'files' ? 'file_read' : 'exec';
  if (!pol.capabilities.includes(cap)) return deny('TARGET_NOT_ALLOWED', `capability_${cap}`);
  if (activeCount >= pol.maxSessionsPerUser) return deny('QUOTA_EXCEEDED', 'max_sessions');
  return allow({ policyVersion: pol.version, idleTimeoutSec: pol.idleTimeoutSec, maxSessionSec: pol.maxSessionSec });
}
```
Pure function, table-tested. Writes need `file_write` checked per operation later.

### 7.4 Host-key enrollment
- `POST /targets/{id}/host-keys` (admin pastes `ssh-ed25519 AAAA…` or `SHA256:` fingerprint from CMDB/console) → stored `trusted`.
- `POST /targets/{id}/host-keys:scan` → broker fetches presented keys (Phase 08 implements) → returned for **manual** comparison; never auto-trusted.
- Target becomes `active` only with ≥ 1 trusted key (or host-CA policy) and a credential ref.

### 7.5 Session + ticket
- `POST /targets/{id}/sessions` → authz → policy → rate limit → `sessions` row AUTHORIZED, `expires_at = now + maxSessionSec` → ticket = 32 random bytes base64url; store SHA-256 only, 60 s TTL, bound to user, session, origin → audit `REMOTE_CONNECT_ALLOWED` (or `_DENIED` with reason).
- `POST /internal/v1/tickets:redeem` (mTLS/service JWT only): atomic `UPDATE … SET redeemed_at=now() WHERE ticket_hash=$1 AND redeemed_at IS NULL AND expires_at>now() RETURNING …` → returns frozen target/policy snapshot.

### 7.6 UI
- `qe-remote`: tree view "Remote Connections" (targets grouped by tag), status icons, Connect (Phase 08), Open Files (Phase 09).
- `qe-admin` (shown only with `target:admin`; server still enforces): target form with live SSRF feedback, host-key approval dialog showing algorithm + fingerprint side by side.

## Tests
- Unit: validators; AddressGuard corpus (IPv4/IPv6/encodings/deny lists); policy truth table.
- Integration: register → list as allowed user (visible) / non-allowed (absent); ticket single use under 10 concurrent redeems → exactly 1 succeeds; expired ticket rejected.
- Security: register `127.0.0.1`, `169.254.169.254`, `metadata.google.internal`, a name resolving to cluster IP → `TARGET_ADDRESS_FORBIDDEN`; non-admin POST /targets → 403.

## Exit criteria
- [ ] Policy and SSRF guard ≥ 95% branch coverage.
- [ ] Ticket issuance/redeem works and is single-use.
- [ ] All decisions audited with reason codes.
