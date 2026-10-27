import {
  FsDeleteRequest,
  FsEmptyResult,
  FsListRequest,
  FsListResult,
  FsMkdirRequest,
  FsReadRequest,
  FsReadResult,
  FsRenameRequest,
  FsStat,
  FsStatRequest,
  FsWriteRequest,
  FsWriteResult,
  ProblemDetails,
  REMOTE_FILE_LIMITS,
  SessionIdParams,
  type FsOp,
} from '@qe/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';

import { principalOf } from '../auth.js';
import type { RemoteFileService } from '../remote-file-service.js';

const errors = {
  400: ProblemDetails,
  401: ProblemDetails,
  403: ProblemDetails,
  404: ProblemDetails,
  409: ProblemDetails,
  410: ProblemDetails,
  413: ProblemDetails,
  429: ProblemDetails,
  502: ProblemDetails,
  503: ProblemDetails,
  504: ProblemDetails,
};
/** An editor polls stat while files are open (Phase 09 §9.5): reads are generous, changes less so. */
const reads = { max: 600, timeWindow: '1 minute' };
const changes = { max: 120, timeWindow: '1 minute' };
/** A 10 MB file is about 13.4 MB as base64, plus the JSON around it. */
const WRITE_BODY_LIMIT = Math.ceil(REMOTE_FILE_LIMITS.maxFileBytes / 3) * 4 + 64 * 1024;

const operations: readonly {
  op: FsOp;
  body: z.ZodType<Record<string, unknown>>;
  response: z.ZodType;
  change: boolean;
}[] = [
  { op: 'stat', body: FsStatRequest, response: FsStat, change: false },
  { op: 'list', body: FsListRequest, response: FsListResult, change: false },
  { op: 'read', body: FsReadRequest, response: FsReadResult, change: false },
  { op: 'write', body: FsWriteRequest, response: FsWriteResult, change: true },
  { op: 'mkdir', body: FsMkdirRequest, response: FsEmptyResult, change: true },
  { op: 'rename', body: FsRenameRequest, response: FsEmptyResult, change: true },
  { op: 'delete', body: FsDeleteRequest, response: FsEmptyResult, change: true },
];

/**
 * `POST /api/v1/sessions/{id}/fs/{op}` (05_API_CONTRACTS §2.4): cookie or bearer, session ownership checked by the
 * service. The route asks only for `remote:file_read` (what opening a files session needs); changes are granted per
 * policy (`file_write` capability, 07_SECURITY §4.2 "per policy") and checked by the service, audited either way.
 */
export function remoteFileRoutes(app: FastifyInstance, files: RemoteFileService): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  for (const { op, body, response, change } of operations) {
    r.post(`/api/v1/sessions/:id/fs/${op}`, {
      schema: { tags: ['sessions'], params: SessionIdParams, body, response: { 200: response, ...errors } },
      config: { permission: 'remote:file_read', audit: change, rateLimit: change ? changes : reads },
      ...(op === 'write' && { bodyLimit: WRITE_BODY_LIMIT }),
      handler: async (
        request: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
        reply,
      ) =>
        reply
          .header('cache-control', 'no-store')
          .send(
            await files.run(
              { principal: principalOf(request), requestId: request.id },
              request.params.id,
              op,
              request.body,
            ),
          ),
    });
  }
}
