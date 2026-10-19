# Phase Gate — Phase 07: Remote Target Registry and Connection Policy

**Date:** 2026-10-19 · **Branch:** `phase-07-targets-policy` (local; owner pushes and merges) · **Reviewers:** @Barathparthi

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_07_REMOTE_TARGET_REGISTRY_AND_POLICY.md`.
Design: `01_ARCHITECTURE/08_REMOTE_CONNECTIVITY_DESIGN.md`, threats T5/T6/T12 in `07_SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md`.

## Deliverables

| Deliverable                | Status                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Validation (§7.1)          | done — host: name or canonical IP only (no `2130706433`, `0177.0.0.1`, `127.1`, zone ids, URLs, user info); port 1–65535 and in the policy; `remoteRoot` absolute and normalised (no `..`, `.`, `//`, control chars, not `/`); principal `{{user.username}}` or a POSIX name; registration refuses any secret-looking field                                                                                                                     | `packages/contracts/src/targets.ts`, `targets.test.ts`                |
| SSRF guard (§7.2)          | done — every resolved address must be in an allowed CIDR and outside built-in denied ranges (loopback, link-local incl. 169.254.169.254, multicast, broadcast, unspecified, reserved, NAT64, 6to4, Teredo) and `TARGET_DENY_CIDRS`; IPv4-mapped IPv6 checked as IPv4; mixed DNS answers refused; the checked address is returned for the connection (no second lookup)                                                                          | `packages/policy/src/address-guard.ts` (100 % lines, 97.8 % branches) |
| Policy evaluation (§7.3)   | done — pure decision with reason codes: target inactive, kind permission (`remote:connect` / `remote:file_read` / `remote:execute`), role in policy, capability, per-user session limit                                                                                                                                                                                                                                                         | `packages/policy/src/connection-policy.ts`                            |
| Host-key enrollment (§7.4) | done — approve an OpenSSH public key (blob type must match its label; SHA256 fingerprint computed) or a CMDB fingerprint; never trust-on-first-use; revoking the last key returns the target to `pending_host_key`; activation needs a trusted key **and** a credential reference                                                                                                                                                               | `target-service.ts`                                                   |
| Session + ticket (§7.5)    | done — visibility (404) → audited policy decision → session `AUTHORIZED` + 256-bit ticket (hash only stored, 60 s, bound to user, session and Origin); internal redeem with service token: ticket burnt on any attempt (wrong Origin included), refused if expired, if the target is no longer active or if its policy version changed; returns a frozen snapshot (target, principal, policy, trusted key fingerprints, credential _reference_) | `remote-session-service.ts`, `routes/targets.ts`                      |
| Admin + user APIs          | done — policies, credential references, targets, host keys (admin, audited); role-filtered target list; own sessions list/close; admins revoke others'                                                                                                                                                                                                                                                                                          | OpenAPI regenerated                                                   |
| UI (§7.6)                  | deferred to Phase 08 — the Remote Connections view and admin forms arrive with "Connect"                                                                                                                                                                                                                                                                                                                                                        | —                                                                     |

## Validation (real output, trimmed)

Local: Windows 11, Node 24.22.0, no Docker.

```text
$ npm run typecheck        → exit 0
$ npm run lint             → 0 problems
$ npm run format:check     → All matched files use Prettier code style!
$ npx vitest run --project unit
 Test Files  38 passed (38)
      Tests  958 passed (958)   (policy 45; host keys, validation, internal routes; authz matrix incl. all new routes)
```

Not run locally: `targets.int.test.ts` (PostgreSQL — CI `integration + coverage`): registration incl. six SSRF refusals
audited, activation rules, role-filtered listing, ticket single use, wrong-Origin burn, expiry, policy-change refusal,
denials audited, session limit, admin revoke, host-key revocation, audit chain.

## Security review

- **Threats touched**: T5 SSRF (allowlist on resolved addresses, deny ranges, canonical forms only), T6 DNS rebinding
  (all answers checked, address pinned for the broker), T12 WebSocket hijacking (single-use, Origin-bound, 60 s
  tickets; never in URLs), T3 IDOR (targets and sessions invisible without role/ownership), T8 (credentials are
  references; nothing secret is stored, returned or audited), T4 (policy roles validated against the RBAC matrix).
- **Internal routes**: `internal` route kind accepts only `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (constant-time
  compare); browser sessions — even an administrator's — get 401; without a configured token the routes are closed.
- **Audit**: `POLICY_CREATE/UPDATE`, `CREDENTIAL_REF_CREATE`, `TARGET_CREATE/UPDATE/DELETE`, `TARGET_HOST_KEY_APPROVED/
REVOKED`, `SSRF_BLOCKED` (own transaction, survives the refused registration), `REMOTE_CONNECT_ALLOWED/DENIED`,
  `REMOTE_SESSION_CLOSED`.

## Deviations from the guide (recorded)

- `POST /targets/{id}/host-keys:scan` (fetch presented keys via the broker) waits for the broker (Phase 08).
- The ticket-redeem path is `/internal/v1/tickets:redeem` as in the contract; service authentication is a shared token
  until mTLS (Phase 16).
- UI deferred to Phase 08 (see Deliverables).
- Session open requires a browser Origin from `ALLOWED_ORIGINS`; desktop Bearer clients arrive in Phase 10.

## Known limitations & follow-ups

- Phase 08: broker re-checks SSRF and host keys at connect, moves sessions to ACTIVE/CLOSED; host-key scan; UI.
- Sweep of stale `AUTHORIZED`/`CONNECTING` sessions and used tickets (`purgeTickets`) to be scheduled with the
  reconciler in Phase 08.

## Decision

- [ ] PASS
- [x] CONDITIONAL — pending CI `integration + coverage` (targets.int.test.ts)
- [ ] FAIL
