import {
  CreateWorkspaceRequest,
  ListWorkspacesQuery,
  ProblemDetails,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceIdParams,
  WorkspaceList,
  WorkspaceTemplateList,
} from '@qe/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { principalOf } from '../auth.js';
import type { RequestContext, WorkspaceService } from '../workspace-service.js';

const errors = {
  400: ProblemDetails,
  401: ProblemDetails,
  403: ProblemDetails,
  404: ProblemDetails,
  409: ProblemDetails,
};
const reads = { max: 120, timeWindow: '1 minute' };
const writes = { max: 30, timeWindow: '1 minute' };

const ctx = (request: FastifyRequest): RequestContext => ({
  principal: principalOf(request),
  requestId: request.id,
});

/** Workspace metadata endpoints (05_API_CONTRACTS §2.2). Start/stop/events arrive with Phase 05. */
export function workspaceRoutes(app: FastifyInstance, service: WorkspaceService): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/v1/workspaces', {
    schema: {
      tags: ['workspaces'],
      querystring: ListWorkspacesQuery,
      response: { 200: WorkspaceList, ...errors },
    },
    config: { permission: 'workspace:read', audit: false, rateLimit: reads },
    handler: async (request) => ({ items: await service.list(ctx(request), request.query.limit) }),
  });

  r.post('/api/v1/workspaces', {
    schema: { tags: ['workspaces'], body: CreateWorkspaceRequest, response: { 201: Workspace, ...errors } },
    config: { permission: 'workspace:create', audit: true, rateLimit: writes },
    handler: async (request, reply) => reply.code(201).send(await service.create(ctx(request), request.body)),
  });

  r.get('/api/v1/workspaces/:id', {
    schema: { tags: ['workspaces'], params: WorkspaceIdParams, response: { 200: Workspace, ...errors } },
    config: { permission: 'workspace:read', audit: false, rateLimit: reads },
    handler: async (request) => service.get(ctx(request), request.params.id),
  });

  r.patch('/api/v1/workspaces/:id', {
    schema: {
      tags: ['workspaces'],
      params: WorkspaceIdParams,
      body: UpdateWorkspaceRequest,
      response: { 200: Workspace, ...errors },
    },
    config: { permission: 'workspace:write', audit: false, rateLimit: writes },
    handler: async (request) => service.update(ctx(request), request.params.id, request.body),
  });

  r.delete('/api/v1/workspaces/:id', {
    schema: { tags: ['workspaces'], params: WorkspaceIdParams, response: { 204: z.null(), ...errors } },
    config: { permission: 'workspace:delete', audit: true, rateLimit: writes },
    handler: async (request, reply) => {
      await service.remove(ctx(request), request.params.id);
      return reply.code(204).send(null);
    },
  });

  r.get('/api/v1/workspace-templates', {
    schema: { tags: ['workspaces'], response: { 200: WorkspaceTemplateList, ...errors } },
    config: { permission: 'workspace:create', audit: false, rateLimit: reads },
    handler: async () => ({ items: await service.templates() }),
  });
}
