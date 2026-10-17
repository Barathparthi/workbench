# Phase 09 — Remote Filesystem

| | |
|---|---|
| **Goal** | Browse, open, edit, save, rename and delete files on a remote target inside its `remoteRoot`, from the IDE |
| **Duration** | 1.5 weeks |
| **Prerequisites** | Phase 08 |
| **Prompt pack** | `03_PROMPTS/PHASE_09_PROMPTS.md` |

## Deliverables
- Broker file API (`kind: files` sessions) with SFTP, path confinement, limits, ETags, audit.
- Theia `FileSystemProvider` for scheme `qe-ssh://{targetId}/…` (frontend, per ADR-006).
- "Open Remote Folder" command → adds remote root to the workspace explorer.
- Conflict handling UI; polling-based change detection.

## Step-by-step

### 9.1 Confinement (two layers)
1. Lexical: `confine(remoteRoot, requested)` (see `01_ARCHITECTURE/08_REMOTE_CONNECTIVITY_DESIGN.md` §8) — reject NUL, absolute, drive letters, escape after normalize.
2. Physical: `sftp.realpath(candidate)` (or of parent for create) must equal root or start with `realpath(root) + '/'`. Cache `realpath(root)` per session.
3. Re-check on **every** operation (symlinks can change between calls).

### 9.2 Operations
| Op | Notes |
|---|---|
| stat | `lstat` then `realpath` check; report symlink type |
| list | `readdir` max 5,000 entries → `truncated: true`; sort dirs first |
| read | size check first (`REMOTE_FILE_TOO_LARGE` > 10 MB); stream with 15 s timeout |
| write | requires `file_write`; `ifMatch` ETag check → temp file + rename (atomic); audit `REMOTE_FILE_WRITE` (path relative, size, no content) |
| mkdir/rename/delete | `file_write`; recursive delete requires explicit flag and depth/count cap; audit |

ETag = `${mtimeMs}-${size}` (document that same-second edits of equal size are a known edge case).

### 9.3 Transport
- One SFTP channel per files-session, reused across ops; request queue with concurrency 4.
- REST `POST /api/v1/sessions/{id}/fs/{op}` (cookie/bearer + ownership) routed to the owning broker instance.
- Session idle timeout closes SFTP; frontend transparently re-opens a session (new ticket) on next op.

### 9.4 Theia integration
```ts
// sketch — confirm class/interface names for the pinned Theia version
@injectable()
export class QeSshFileSystemProvider implements FileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;
  readonly onDidChangeFile = this.changes.event;           // fed by polling watcher
  stat(uri: URI) { return this.client.fs(target(uri)).stat(rel(uri)); }
  readdir(uri: URI) { /* map to [name, FileType] */ }
  readFile(uri: URI) { /* base64 → Uint8Array */ }
  writeFile(uri: URI, content: Uint8Array, opts: FileWriteOptions) { /* ifMatch from last read */ }
  mkdir / rename / delete / watch(...)
}
// registered for scheme 'qe-ssh' through a FileServiceContribution
```
- Explorer shows remote folder with a distinct icon and "[target-name]" suffix.
- Large-file and binary handling: open read-only preview above a threshold.

### 9.5 Watching
- Poll stat of open editors' files every 5 s and expanded directories every 10 s (configurable, backoff when idle) → `onDidChangeFile`.
- Editor shows "file changed on remote" with Compare/Reload/Overwrite.

## Tests
- Integration (OpenSSH container): full CRUD; atomic write; ETag conflict (modify via side channel) → 409.
- Security: traversal corpus (`01_ARCHITECTURE/11_TESTING_STRATEGY.md` §6); symlink to `/etc` inside root → denied; symlink swapped between stat and read → denied; write without `file_write` → 403; 11 MB read → 413.
- E2E: open remote folder, edit, save, reopen → persisted; conflict dialog.
- Windows OpenSSH target (if in scope): path mapping and CRUD.

## Exit criteria
- [ ] **Milestone M2 complete**: remote terminal + remote file editing.
- [ ] Traversal/symlink suite 100% green.
- [ ] Remote save p95 < 1 s on lab network.
