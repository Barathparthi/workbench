import {
  FsDeleteRequest,
  FsListRequest,
  FsMkdirRequest,
  FsReadRequest,
  FsRenameRequest,
  FsStatRequest,
  FsWriteRequest,
  type FsOp,
} from '@qe/contracts';

import type { RemoteFileSystem } from './remote-fs.js';

/** Validates one operation's request and runs it; contents cross the wire as base64 only. */
export function fileOperation(op: FsOp, request: unknown): (fs: RemoteFileSystem) => Promise<unknown> {
  switch (op) {
    case 'stat': {
      const r = FsStatRequest.parse(request);
      return (fs) => fs.stat(r);
    }
    case 'list': {
      const r = FsListRequest.parse(request);
      return (fs) => fs.list(r);
    }
    case 'read': {
      const r = FsReadRequest.parse(request);
      return async (fs) => {
        const { data, etag } = await fs.read(r);
        return { contentBase64: data.toString('base64'), etag };
      };
    }
    case 'write': {
      const { contentBase64, ...r } = FsWriteRequest.parse(request);
      return (fs) => fs.write({ ...r, data: Buffer.from(contentBase64, 'base64') });
    }
    case 'mkdir': {
      const r = FsMkdirRequest.parse(request);
      return async (fs) => {
        await fs.mkdir(r);
        return {};
      };
    }
    case 'rename': {
      const r = FsRenameRequest.parse(request);
      return async (fs) => {
        await fs.rename(r);
        return {};
      };
    }
    case 'delete': {
      const r = FsDeleteRequest.parse(request);
      return async (fs) => {
        await fs.delete(r);
        return {};
      };
    }
  }
}
