# Phase 12 — Enterprise SSO, Secrets and Audit

| | |
|---|---|
| **Goal** | Production identity, secret management (short-lived SSH certificates) and a complete audit trail |
| **Duration** | 1.5–2 weeks |
| **Prerequisites** | Phases 04, 08; IdP app registration; Vault (or chosen secret manager) access |
| **Prompt pack** | `03_PROMPTS/PHASE_12_PROMPTS.md` |

## Deliverables
- Corporate OIDC configured (issuer, client, group→role mapping) via config only.
- Session revalidation against user status; revocation API; (optional) SCIM deprovisioning hook.
- `packages/secrets`: `SecretProvider` + `VaultProvider` (+ cloud adapter if required); dev provider guarded off in prod.
- `VaultCredentialSource` for broker: SSH certificates (preferred), KV key/password (fallback).
- Audit viewer + CSV export; audit coverage test; hash-chain verifier job.

## Step-by-step

### 12.1 Corporate OIDC
- Register confidential client (web) + public client (desktop, PKCE, loopback redirect).
- Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (from secret store), `OIDC_SCOPES`, `ROLE_MAPPINGS` (JSON: group → role).
- Handle group overage (Entra ID large groups) — use app roles or Graph lookup per IdP guidance.
- Every 10 min per active session: check `users.status`; disabled → kill sessions + broker sessions.

### 12.2 SecretProvider
```ts
export interface SecretProvider {
  readKv(path: string): Promise<Record<string, string>>;                         // broker only
  signSshKey(role: string, publicKey: string, principals: string[], ttlSec: number): Promise<{ certificate: string; serial: string }>;
  health(): Promise<'ok' | 'degraded' | 'down'>;
}
```
- Vault auth: Kubernetes auth method (broker ServiceAccount) — no static Vault token.
- Vault policy for broker: `update` on `ssh-client-signer/sign/<roles>`, `read` on `kv/data/qews/targets/*`; nothing else. Control plane gets **no** Vault access to target credentials.
- Timeouts 3 s, retries with jitter (2), circuit breaker → `CREDENTIALS_UNAVAILABLE`.

### 12.3 SSH certificate flow
1. Broker generates ephemeral ed25519 keypair in memory per connection.
2. `signSshKey(role, pub, [principal], 600)` → cert (Vault role restricts principals, TTL ≤ 15 min, extensions `permit-pty` only).
3. Connect with key + cert (per spike S4 approach); zero-fill private key buffer after `ready`.
4. Audit `CREDENTIAL_ISSUED` with cert serial + TTL (never material).
5. Targets trust the user CA: `TrustedUserCAKeys /etc/ssh/qews_user_ca.pub`; optional `AuthorizedPrincipalsFile`.
Provide a target-onboarding script (`scripts/target-onboard.sh`) for lab admins.

### 12.4 Remove dev paths from production
- Build-time/config guard: `FileDevSecretProvider` and `AUTH_MODE=dev` cause startup failure when `NODE_ENV=production`.
- Test: production image + dev config → container exits non-zero.

### 12.5 Audit completeness
- Coverage test: for each privileged route/broker action, perform it and assert the expected audit action exists with actor/resource/result.
- Audit viewer (`qe-admin`): filters, pagination, CSV export (`audit:export`), clock-skew-safe ordering.
- Nightly job verifies hash chain and exports to WORM/archive storage; alert on break.

## Tests
- Integration: Vault dev container with SSH engine; cert principals/TTL; Vault down → `CREDENTIALS_UNAVAILABLE` and no connect attempt.
- Security: broker SA cannot read other Vault paths; control plane SA cannot sign; disabled user → sessions closed ≤ 10 min (configurable down to 1 min).
- Leak scan with canary secret in Vault KV: never appears in logs/traces/responses.

## Exit criteria
- [ ] Login through corporate IdP in staging; roles from groups.
- [ ] SSH via short-lived certificates to a staging lab host.
- [ ] Audit coverage test green; chain verifier green.
