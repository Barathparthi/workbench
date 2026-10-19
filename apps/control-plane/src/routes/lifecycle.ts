import { ProblemDetails, Workspace, WorkspaceIdParams, type WorkspaceStateEvent } from '@qe/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { principalOf } from '../auth.js';
import type { WorkspaceLifecycle } from '../workspace-lifecycle.js';
import type { WorkspaceService } from '../workspace-service.js';

const errors = {
  401: ProblemDetails,
  403: ProblemDetails,
  404: ProblemDetails,
  409: ProblemDetails,
  429: ProblemDetails,
};
/** 07_SECURITY §4.5: workspace starts are limited per user. */
const startLimit = { max: 10, timeWindow: '1 minute' };
const SSE_HEARTBEAT_MS = 25_000;
const SSE_MAX_MS = 10 * 60_000; // clients reconnect; keeps stale streams from piling up

/** Start, stop and state events (05_API_CONTRACTS §2.2). Both commands are idempotent and answer 202. */
export function lifecycleRoutes(
  app: FastifyInstance,
  lifecycle: WorkspaceLifecycle,
  workspaces: WorkspaceService,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/api/v1/workspaces/:id/start', {
    schema: { tags: ['workspaces'], params: WorkspaceIdParams, response: { 202: Workspace, ...errors } },
    config: { permission: 'workspace:start', audit: true, rateLimit: startLimit },
    handler: async (request, reply) =>
      reply
        .code(202)
        .send(
          await lifecycle.start(
            { principal: principalOf(request), requestId: request.id },
            request.params.id,
          ),
        ),
  });

  r.post('/api/v1/workspaces/:id/stop', {
    schema: { tags: ['workspaces'], params: WorkspaceIdParams, response: { 202: Workspace, ...errors } },
    config: { permission: 'workspace:stop', audit: true, rateLimit: startLimit },
    handler: async (request, reply) =>
      reply
        .code(202)
        .send(
          await lifecycle.stop({ principal: principalOf(request), requestId: request.id }, request.params.id),
        ),
  });

  r.get('/api/v1/workspaces/:id/events', {
    schema: { tags: ['workspaces'], params: WorkspaceIdParams, response: errors },
    config: { permission: 'workspace:read', audit: false, rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      // Visibility first (404 for non-members), then stream.
      const current = await workspaces.get(
        { principal: principalOf(request), requestId: request.id },
        request.params.id,
      );
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-request-id': request.id,
      });
      const send = (e: WorkspaceStateEvent) => res.write(`event: state\ndata: ${JSON.stringify(e)}\n\n`);
      send({ id: current.id, state: current.state, reason: null });
      const unsubscribe = lifecycle.events.subscribe(current.id, send);
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), SSE_HEARTBEAT_MS);
      const end = setTimeout(() => res.end(), SSE_MAX_MS);
      res.on('close', () => {
        unsubscribe();
        clearInterval(heartbeat);
        clearTimeout(end);
      });
    },
  });
}
