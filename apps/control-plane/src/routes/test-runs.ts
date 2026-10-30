import {
  CreateTestRunRequest,
  ListTestRunsQuery,
  ProblemDetails,
  TestRun,
  TestRunIdParams,
  TestRunList,
  TestRunResultRequest,
  WorkspaceIdParams,
} from '@qe/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { principalOf } from '../auth.js';
import type { TestRunService } from '../test-run-service.js';
import type { RequestContext } from '../workspace-service.js';

const errors = {
  400: ProblemDetails,
  401: ProblemDetails,
  403: ProblemDetails,
  404: ProblemDetails,
  409: ProblemDetails,
};
const reads = { max: 120, timeWindow: '1 minute' };
const writes = { max: 60, timeWindow: '1 minute' };

const ctx = (request: FastifyRequest): RequestContext => ({
  principal: principalOf(request),
  requestId: request.id,
});

/**
 * QE runner records (05_API_CONTRACTS §2.5). A run in the workspace runtime is recorded when it starts and finished
 * once by the user who started it; runs on remote targets arrive with P11.4.
 */
export function testRunRoutes(app: FastifyInstance, service: TestRunService): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/api/v1/workspaces/:id/test-runs', {
    schema: {
      tags: ['test-runs'],
      params: WorkspaceIdParams,
      body: CreateTestRunRequest,
      response: { 201: TestRun, ...errors },
    },
    config: { permission: 'qe_test:execute', audit: true, rateLimit: writes },
    handler: async (request, reply) =>
      reply.code(201).send(await service.create(ctx(request), request.params.id, request.body)),
  });

  r.post('/api/v1/test-runs/:id/result', {
    schema: {
      tags: ['test-runs'],
      params: TestRunIdParams,
      body: TestRunResultRequest,
      response: { 200: TestRun, ...errors },
    },
    config: { permission: 'qe_test:execute', audit: true, rateLimit: writes },
    handler: async (request) => service.finish(ctx(request), request.params.id, request.body),
  });

  r.get('/api/v1/test-runs', {
    schema: {
      tags: ['test-runs'],
      querystring: ListTestRunsQuery,
      response: { 200: TestRunList, ...errors },
    },
    config: { permission: 'workspace:read', audit: false, rateLimit: reads },
    handler: async (request) => ({
      items: await service.list(ctx(request), request.query.workspaceId, request.query.limit),
    }),
  });

  r.get('/api/v1/test-runs/:id', {
    schema: { tags: ['test-runs'], params: TestRunIdParams, response: { 200: TestRun, ...errors } },
    config: { permission: 'workspace:read', audit: false, rateLimit: reads },
    handler: async (request) => service.get(ctx(request), request.params.id),
  });
}
