# Prompt Pack — Phase 00: Environment, Decisions & Spikes

Phase guide: `02_PHASES/PHASE_00_ENVIRONMENT_DECISIONS_SPIKES.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P00.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P00.1 … P00.7 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P00.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 00 — Environment, Decisions & Spikes
Read docs/phases/PHASE_00_ENVIRONMENT_DECISIONS_SPIKES.md (copy of the kit's phase guide) fully before anything else.
GOAL: Capture org inputs, pin versions, and de-risk Theia/ssh2/routing/extension unknowns with throwaway spikes.
IN SCOPE: spikes/ folder (throwaway); docs/ORG_DECISIONS.md; docs/adr/*
OUT OF SCOPE (do not touch): Product code under apps/, packages/, extensions/
ACCEPTANCE: Versions pinned with sources; S1–S5 reports; ADR-005/006 drafted; open org decisions listed with owners.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 00`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P00.1 — Version research

```text
Research (do not guess) the latest stable Eclipse Theia community release, its required Node.js range and
Electron version. Recommend a Node Active LTS that satisfies it. Output a table: item | version | source URL |
date checked. Flag anything you could not verify.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P00.2 — Spike S1 — Theia hello (browser + Electron)

```text
In spikes/s1-theia-hello create a minimal Theia browser app AND electron app sharing one extension `qe-hello`
with command `qe.hello`. Use the official generator/layout for the pinned version. Give exact build/start
commands for both targets and run them. Report build time, bundle size, any native-module rebuild steps (node-
pty) on this OS.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P00.3 — Spike S2 — base path / reverse proxy

```text
In spikes/s2-proxy put a small Fastify reverse proxy (@fastify/http-proxy with websocket:true) in front of the
S1 browser app at /w/test-ws/. Verify assets, Theia WebSocket, terminal and webviews. If base paths are not
supported cleanly, prototype subdomain routing instead. Write findings + recommendation for ADR-005.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P00.4 — Spike S3 — remote terminal + remote FS approach

```text
Prototype, time-boxed, the options in PHASE_00 step 0.6: (A) VS Code API Pseudoterminal +
registerFileSystemProvider in a built-in plugin, (B) Theia frontend TerminalWidget/xterm + FileSystemProvider
via FileServiceContribution, (C) standalone xterm widget. For each: does it run in browser AND Electron, does
it keep SSH reachability out of the runtime (principle P9), which Theia APIs it depends on. Recommend one for
ADR-006.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P00.5 — Spike S4 — ssh2 deep-check

```text
In spikes/s4-ssh2, against a Docker sshd with a known ed25519 host key: implement hostVerifier with SHA256
fingerprints and prove it matches `ssh-keygen -lf`; test OpenSSH user-certificate auth with a Vault dev SSH
engine; agent auth on this OS; jump host via forwardOut+sock; PTY resize; Ctrl+C via \x03 vs channel.signal.
Report what works with the pinned ssh2 version.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P00.6 — Spike S5 — extensions

```text
For each extension in docs/ORG_DECISIONS.md A8, check availability on Open VSX (or our mirror), licence, and
Theia compatibility notes. Propose alternatives for missing ones.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P00.7 — ADRs and risks

```text
Draft ADR-005 (workspace routing) and ADR-006 (remote terminal/FS approach) and update ADR-002 with S4
results, using docs/adr/ADR_TEMPLATE.md. Add new risks to the risk register.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
(spike-specific commands reported in each step)
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Versions pinned with sources; S1–S5 reports; ADR-005/006 drafted; open org decisions listed with owners.
