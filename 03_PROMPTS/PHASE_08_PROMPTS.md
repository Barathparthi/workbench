# Prompt Pack — Phase 08: SSH Broker & Remote Terminal

Phase guide: `02_PHASES/PHASE_08_SSH_BROKER_AND_REMOTE_TERMINAL.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P08.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P08.1 … P08.7 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P08.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 08 — SSH Broker & Remote Terminal
Read docs/phases/PHASE_08_SSH_BROKER_AND_REMOTE_TERMINAL.md (copy of the kit's phase guide) fully before anything else.
GOAL: Broker that redeems tickets, re-checks policy/SSRF, resolves credentials, verifies host keys, opens SSH PTY and bridges qews.v1 to a Theia terminal.
IN SCOPE: packages/broker-core; apps/connection-broker; extensions/qe-remote terminal; packages/test-utils ssh fixtures
OUT OF SCOPE (do not touch): SFTP (Phase 09); Vault (Phase 12 — use dev file credentials now)
ACCEPTANCE: Browser → registered target → SSH terminal with all checks; full negative table green; no secret leakage.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 08`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P08.1 — Test fixtures

```text
In packages/test-utils add startSshServer({hostKey, users, authorizedKeys}) using Testcontainers (OpenSSH
image) and a second server with a different host key. Document fixtures.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P08.2 — SshTransport + HostKeyVerifier

```text
Implement interfaces and the ssh2 adapter exactly as in the guide (hardened algorithms, timeouts, keepalive,
reject remote-initiated forwards, error mapping). HostKeyVerifier supports pinned SHA256 fingerprints (and a
host-CA stub). Integration tests: happy path, mismatch, unknown, wrong creds, unreachable, timeout.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P08.3 — WS protocol codec

```text
Implement qews.v1 codec in packages/contracts: JSON control messages (Zod) + binary frames with type prefix,
size limits, close codes. Unit tests for malformed/oversized/unknown frames.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P08.4 — Broker stream handler

```text
Implement the 10-step sequence in guide 8.3 including ticket via subprotocol, Origin check, re-check policy +
AddressGuard, credentials (dev file source), connect to pinned IP, PTY, bridge, backpressure (pause >1 MiB
unacked), idle/absolute timers, idempotent close, state reports, audit.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P08.5 — Registry + revocation + shutdown

```text
Implement SessionRegistry with per-user/target caps, internal close and close-all endpoints (4011), SIGTERM
drain (4013). Tests.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P08.6 — Frontend remote terminal

```text
Implement Connect action → session create → WS with ticket subprotocol → terminal widget per ADR-006; resize
debounce; friendly close-code messages; Reconnect. Same code path used later by desktop.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P08.7 — Negative + abuse tests

```text
Automate every row of the guide's test table including 'unauthorized user → no SYN reaches sshd' and output
flood with bounded broker memory. Add canary leak scan of logs/traces.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run test:unit -w @qe/broker-core
npm run test:integration -w @qe/broker-core
npm run test:integration -w @qe/connection-broker
npx playwright test tests/e2e/remote-terminal.spec.ts
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Browser → registered target → SSH terminal with all checks; full negative table green; no secret leakage.
