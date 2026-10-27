import { z } from 'zod';

/**
 * Remote file operations on a `files` session (05_API_CONTRACTS §2.4, PHASE_09 §9.2). Paths are POSIX style and
 * relative to the target's `remoteRoot`; the broker confines them (lexically and with the server's realpath) on
 * every call. File contents travel base64 encoded and are never logged or audited.
 */

export const REMOTE_FILE_LIMITS = {
  /** Largest file `read` returns, and the largest `write` accepts. */
  maxFileBytes: 10 * 1024 * 1024,
  maxListEntries: 5_000,
  /** One operation, end to end on the broker. */
  opTimeoutMs: 15_000,
  /** Recursive delete refuses larger trees before removing anything. */
  maxDeleteEntries: 10_000,
  maxDeleteDepth: 32,
} as const;

export const FsOp = z.enum(['stat', 'list', 'read', 'write', 'mkdir', 'rename', 'delete']);

/** Semantics (no escape, no NUL) are checked by the broker's confinement; this only bounds the size. */
export const RemotePath = z.string().max(4096);

/**
 * In a listing every symlink is `symlink` (links are not followed there). In a stat, `symlink` means a link the
 * broker will not follow (it leaves the root, or points nowhere); a followed link has its target's type.
 */
export const RemoteFileType = z.enum(['file', 'directory', 'symlink', 'other']);

/** `${mtimeMs}-${size}`. SFTP mtimes have whole seconds, so a same-second edit of equal size is not detected. */
export const ETag = z.string().regex(/^\d{1,16}-\d{1,16}$/);

const MAX_BASE64_LENGTH = Math.ceil(REMOTE_FILE_LIMITS.maxFileBytes / 3) * 4;

export const FsStatRequest = z.strictObject({ path: RemotePath });
export const FsListRequest = z.strictObject({
  path: RemotePath,
  limit: z.number().int().min(1).max(REMOTE_FILE_LIMITS.maxListEntries).optional(),
});
export const FsReadRequest = z.strictObject({
  path: RemotePath,
  maxBytes: z.number().int().min(1).max(REMOTE_FILE_LIMITS.maxFileBytes).optional(),
});
export const FsWriteRequest = z.strictObject({
  path: RemotePath,
  contentBase64: z.base64().max(MAX_BASE64_LENGTH),
  ifMatch: ETag.optional(),
  create: z.boolean().optional(),
  overwrite: z.boolean().optional(),
});
export const FsMkdirRequest = z.strictObject({ path: RemotePath, recursive: z.boolean().optional() });
export const FsRenameRequest = z.strictObject({
  from: RemotePath,
  to: RemotePath,
  overwrite: z.boolean().optional(),
});
export const FsDeleteRequest = z.strictObject({ path: RemotePath, recursive: z.boolean().optional() });

export const FsStat = z.strictObject({
  type: RemoteFileType,
  /** The path itself is a symlink (followed when it stays inside the root: `type` is then the target's). */
  symlink: z.boolean(),
  size: z.number().int().min(0),
  mtimeMs: z.number().int().min(0),
  /** Permission bits only (`mode & 0o7777`). */
  mode: z.number().int().min(0).max(0o7777),
  etag: ETag,
});
export const FsListEntry = z.strictObject({
  name: z.string(),
  type: RemoteFileType,
  size: z.number().int().min(0),
  mtimeMs: z.number().int().min(0),
});
export const FsListResult = z.strictObject({ entries: z.array(FsListEntry), truncated: z.boolean() });
export const FsReadResult = z.strictObject({ contentBase64: z.base64(), etag: ETag });
export const FsWriteResult = z.strictObject({ etag: ETag });
export const FsEmptyResult = z.strictObject({});

export type FsOp = z.infer<typeof FsOp>;
export type RemoteFileType = z.infer<typeof RemoteFileType>;
export type FsStatRequest = z.infer<typeof FsStatRequest>;
export type FsListRequest = z.infer<typeof FsListRequest>;
export type FsReadRequest = z.infer<typeof FsReadRequest>;
export type FsWriteRequest = z.infer<typeof FsWriteRequest>;
export type FsMkdirRequest = z.infer<typeof FsMkdirRequest>;
export type FsRenameRequest = z.infer<typeof FsRenameRequest>;
export type FsDeleteRequest = z.infer<typeof FsDeleteRequest>;
export type FsStat = z.infer<typeof FsStat>;
export type FsListEntry = z.infer<typeof FsListEntry>;
export type FsListResult = z.infer<typeof FsListResult>;
export type FsReadResult = z.infer<typeof FsReadResult>;
export type FsWriteResult = z.infer<typeof FsWriteResult>;
