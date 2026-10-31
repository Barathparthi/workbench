import {
  BrokerTestRunResult,
  CreateTestRunRequest,
  DESKTOP_TICKET_ORIGIN,
  RemoteTestRunResponse,
  StartRemoteTestRunRequest,
  TargetIdParams,
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

/** As for sessions: the desktop app's bearer token binds tickets to its marker, browsers to their Origin. */
const ticketBinding = (request: FastifyRequest): string | undefined => {
  if (request.authMethod === 'bearer') return DESKTOP_TICKET_ORIGIN;
  const origin = request.headers.origin;
  return origin === DESKTOP_TICKET_ORIGIN ? undefined : origin;
};

const ctx = (request: FastifyRequest): RequestContext => ({
  principal: principalOf(request),
  requestId: request.id,
});

/**
 * QE runner records (05_API_CONTRACTS §2.5). A run in the workspace runtime is recorded when it starts and finished
 * once by the user who started it. A run on a remote target rides on an exec session: the broker runs it and reports
 * its result; closing the session cancels it.
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

  r.post('/api/v1/targets/:id/test-runs', {
    schema: {
      tags: ['test-runs'],
      params: TargetIdParams,
      body: StartRemoteTestRunRequest,
      response: { 201: RemoteTestRunResponse, ...errors },
    },
    // remote:execute and the policy's exec capability are checked by the session decision (05 §2.5).
    config: { permission: 'qe_test:execute', audit: true, rateLimit: writes },
    handler: async (request, reply) =>
      reply
        .code(201)
        .header('cache-control', 'no-store')
        .send(
          await service.startRemote(ctx(request), request.params.id, request.body, ticketBinding(request)),
        ),
  });

  r.post('/api/v1/test-runs/:id/cancel', {
    schema: { tags: ['test-runs'], params: TestRunIdParams, response: { 200: TestRun, ...errors } },
    config: { permission: 'qe_test:cancel', audit: true, rateLimit: writes },
    handler: async (request) => service.cancel(ctx(request), request.params.id),
  });

  r.post('/internal/v1/test-runs/:id/result', {
    schema: {
      tags: ['internal'],
      params: TestRunIdParams,
      body: BrokerTestRunResult,
      response: { 200: TestRun, ...errors },
    },
    config: { permission: 'internal', audit: true, rateLimit: { max: 600, timeWindow: '1 minute' } },
    handler: async (request) => service.finishFromBroker(request.params.id, request.body),
  });
}
