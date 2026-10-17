# Prompt Pack — Phase 09: Remote Filesystem

Phase guide: `02_PHASES/PHASE_09_REMOTE_FILESYSTEM.md`  
Use with: `00_SESSION_BOOTSTRAP_PROMPT.md` (first) and `01_STANDARD_8_STEP_LOOP.md`.

## Order of use

```text
Bootstrap → P09.0 Context → [LOOP-1] Inspect → [LOOP-2] Plan (human approves)
→ P09.1 … P09.5 (one at a time, commit after each)
→ [LOOP-4] Review → [LOOP-5] Fix → [LOOP-6] Validate → [LOOP-7] Document → [LOOP-8] Gate
```

## P09.0 — Phase context (paste after bootstrap)

```text
CURRENT PHASE: Phase 09 — Remote Filesystem
Read docs/phases/PHASE_09_REMOTE_FILESYSTEM.md (copy of the kit's phase guide) fully before anything else.
GOAL: SFTP-backed file operations confined to remoteRoot, exposed as a qe-ssh:// FileSystemProvider in Theia with conflict handling.
IN SCOPE: packages/broker-core fs; apps/connection-broker fs routes; extensions/qe-remote FileSystemProvider
OUT OF SCOPE (do not touch): remote language servers (Phase 19)
ACCEPTANCE: Milestone M2 complete; traversal/symlink suite 100% green; remote save p95 < 1 s.
Acknowledge with: (1) your understanding of the goal in 3 bullets, (2) prerequisites you will verify, (3) questions. Do not edit files.
```

## Inspect and plan
Run **[LOOP-1]** then **[LOOP-2]** with `<PHASE>` = `Phase 09`. Approve the plan before continuing.

## Implementation prompts (one at a time)

### P09.1 — confine()

```text
Implement lexical confine(remoteRoot, requested) and physical realpath check helper per the guide. Unit tests
with the full traversal corpus from the testing strategy.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P09.2 — SFTP operations

```text
Implement stat/list/read/write/mkdir/rename/delete with limits (10 MB read, 5,000 entries, 15 s), ETag, atomic
write via temp+rename, capability checks (file_write), audit for mutations. Integration tests incl. symlink
escape and symlink swap between calls.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P09.3 — Broker API

```text
Expose POST /api/v1/sessions/{id}/fs/{op} with ownership checks and routing to the owning broker; files-
session lifecycle and transparent re-open.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P09.4 — Theia provider

```text
Implement QeSshFileSystemProvider (frontend) and register for scheme qe-ssh; 'Open Remote Folder' command adds
it to the explorer with a distinct label.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

### P09.5 — Watch + conflicts

```text
Polling watcher for open files/expanded dirs with backoff; 'changed on remote' Compare/Reload/Overwrite; write
with ifMatch → 409 handling. E2E conflict test.

Constraints: stay within this step; add positive and negative tests; run typecheck, lint and the
affected tests; report with the standard response format using ACTUAL command output.
```

## Review, validate, document, gate

Run **[LOOP-4]** → **[LOOP-5]** → **[LOOP-6]** → **[LOOP-7]** → **[LOOP-8]**.

Validation commands for [LOOP-6]:

```bash
npm run test:unit -w @qe/broker-core
npm run test:integration -w @qe/broker-core
npx vitest run tests/security/traversal.test.ts
npx playwright test tests/e2e/remote-files.spec.ts
```

## Human checklist before merging

- [ ] Plan was approved before implementation
- [ ] Diff reviewed; no weakened tests; no `any`/ts-ignore without reason
- [ ] Negative/security tests present for every privileged path
- [ ] No secrets, keys, tokens in code, fixtures, logs or snapshots
- [ ] Telemetry + audit added where required
- [ ] Docs updated; phase gate filled with real output
- [ ] Acceptance met: Milestone M2 complete; traversal/symlink suite 100% green; remote save p95 < 1 s.
