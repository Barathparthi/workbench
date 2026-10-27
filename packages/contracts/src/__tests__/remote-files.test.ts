import { describe, expect, it } from 'vitest';

import { FsListRequest, FsReadRequest, FsStat, FsWriteRequest, REMOTE_FILE_LIMITS } from '../index.js';

describe('remote file contracts', () => {
  it('accepts a write and bounds its content to the file limit', () => {
    const small = Buffer.from('print("hi")\n').toString('base64');
    expect(
      FsWriteRequest.parse({ path: 'a.py', contentBase64: small, ifMatch: '1761000000000-12' }),
    ).toMatchObject({
      path: 'a.py',
    });
    const tooBig = 'A'.repeat(Math.ceil(REMOTE_FILE_LIMITS.maxFileBytes / 3) * 4 + 4);
    expect(FsWriteRequest.safeParse({ path: 'a', contentBase64: tooBig }).success).toBe(false);
  });

  it.each([
    { path: 'a', contentBase64: 'not base64!' },
    { path: 'a', contentBase64: '', ifMatch: 'W/"x"' },
    { path: 'a', contentBase64: '', extra: true },
    { path: 'x'.repeat(4097), contentBase64: '' },
  ])('refuses a malformed write %#', (body) => {
    expect(FsWriteRequest.safeParse(body).success).toBe(false);
  });

  it('caps list and read sizes', () => {
    expect(FsListRequest.safeParse({ path: '', limit: REMOTE_FILE_LIMITS.maxListEntries }).success).toBe(
      true,
    );
    expect(FsListRequest.safeParse({ path: '', limit: REMOTE_FILE_LIMITS.maxListEntries + 1 }).success).toBe(
      false,
    );
    expect(FsReadRequest.safeParse({ path: '', maxBytes: REMOTE_FILE_LIMITS.maxFileBytes + 1 }).success).toBe(
      false,
    );
  });

  it('keeps only permission bits in a stat', () => {
    const stat = { type: 'file', symlink: false, size: 1, mtimeMs: 0, etag: '0-1' };
    expect(FsStat.safeParse({ ...stat, mode: 0o644 }).success).toBe(true);
    expect(FsStat.safeParse({ ...stat, mode: 0o100644 }).success).toBe(false);
  });
});
