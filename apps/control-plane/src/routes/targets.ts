import {
  AddHostKeyRequest,
  BrokerInstanceParams,
  ConnectionPolicy,
  ConnectionPolicyList,
  CreateCredentialRefRequest,
  CreatePolicyRequest,
  CredentialRef,
  DESKTOP_TICKET_ORIGIN,
  HostKeyParams,
  OpenSessionRequest,
  OpenSessionResponse,
  ProblemDetails,
  RedeemTicketRequest,
  RedeemTicketResponse,
  RegisterTargetRequest,
  RemoteSession,
  RemoteSessionList,
  SessionIdParams,
  SessionStateReport,
  Target,
  TargetIdParams,
  TargetList,
  UpdatePolicyRequest,
  UpdateTargetRequest,
} from '@qe/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { principalOf } from '../auth.js';
import type { RemoteSessionService } from '../remote-session-service.js';
import type { TargetService } from '../target-service.js';
import type { RequestContext } from '../workspace-service.js';

const errors = {
  400: ProblemDetails,
  401: ProblemDetails,
  403: ProblemDetails,
  404: ProblemDetails,
  409: ProblemDetails,
  429: ProblemDetails,
};
const reads = { max: 120, timeWindow: '1 minute' };
const adminWrites = { max: 30, timeWindow: '1 minute' };
/** 07_SECURITY §4.5: session opens per user. */
const sessionOpens = { max: 20, timeWindow: '1 minute' };

const ctx = (request: FastifyRequest): RequestContext => ({
  principal: principalOf(request),
  requestId: request.id,
});

/**
 * What the session's ticket is bound to: the IDE's Origin for browser sessions, the desktop marker for the desktop
 * app's bearer token (it has no Origin). A browser request can never claim the marker.
 */
const ticketBinding = (request: FastifyRequest): string | undefined => {
  if (request.authMethod === 'bearer') return DESKTOP_TICKET_ORIGIN;
  const origin = request.headers.origin;
  return origin === DESKTOP_TICKET_ORIGIN ? undefined : origin;
};

/** Policies, credential references, targets, host keys and remote sessions (05_API_CONTRACTS §2.3–2.4). */
export function targetRoutes(
  app: FastifyInstance,
  targets: TargetService,
  sessions: RemoteSessionService,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── policies (admin) ──
  r.get('/api/v1/policies', {
    schema: { tags: ['targets'], response: { 200: ConnectionPolicyList, ...errors } },
    config: { permission: 'policy:admin', audit: false, rateLimit: reads },
    handler: async () => ({ items: await targets.listPolicies() }),
  });
  r.post('/api/v1/policies', {
    schema: { tags: ['targets'], body: CreatePolicyRequest, response: { 201: ConnectionPolicy, ...errors } },
    config: { permission: 'policy:admin', audit: true, rateLimit: adminWrites },
    handler: async (request, reply) =>
      reply.code(201).send(await targets.createPolicy(ctx(request), request.body)),
  });
  r.patch('/api/v1/policies/:id', {
    schema: {
      tags: ['targets'],
      params: TargetIdParams,
      body: UpdatePolicyRequest,
      response: { 200: ConnectionPolicy, ...errors },
    },
    config: { permission: 'policy:admin', audit: true, rateLimit: adminWrites },
    handler: async (request) => targets.updatePolicy(ctx(request), request.params.id, request.body),
  });

  // ── credential references (admin; pointers into the secret manager, never secrets) ──
  r.post('/api/v1/credential-refs', {
    schema: {
      tags: ['targets'],
      body: CreateCredentialRefRequest,
      response: { 201: CredentialRef, ...errors },
    },
    config: { permission: 'target:admin', audit: true, rateLimit: adminWrites },
    handler: async (request, reply) =>
      reply.code(201).send(await targets.createCredentialRef(ctx(request), request.body)),
  });

  // ── targets ──
  r.get('/api/v1/targets', {
    schema: { tags: ['targets'], response: { 200: TargetList, ...errors } },
    config: { permission: 'target:list', audit: false, rateLimit: reads },
    handler: async (request) => ({ items: await targets.listTargets(ctx(request)) }),
  });
  r.get('/api/v1/targets/:id', {
    schema: { tags: ['targets'], params: TargetIdParams, response: { 200: Target, ...errors } },
    config: { permission: 'target:list', audit: false, rateLimit: reads },
    handler: async (request) => targets.getTarget(ctx(request), request.params.id),
  });
  r.post('/api/v1/targets', {
    schema: { tags: ['targets'], body: RegisterTargetRequest, response: { 201: Target, ...errors } },
    config: { permission: 'target:admin', audit: true, rateLimit: adminWrites },
    handler: async (request, reply) =>
      reply.code(201).send(await targets.registerTarget(ctx(request), request.body)),
  });
  r.patch('/api/v1/targets/:id', {
    schema: {
      tags: ['targets'],
      params: TargetIdParams,
      body: UpdateTargetRequest,
      response: { 200: Target, ...errors },
    },
    config: { permission: 'target:admin', audit: true, rateLimit: adminWrites },
    handler: async (request) => targets.updateTarget(ctx(request), request.params.id, request.body),
  });
  r.delete('/api/v1/targets/:id', {
    schema: { tags: ['targets'], params: TargetIdParams, response: { 204: z.null(), ...errors } },
    config: { permission: 'target:admin', audit: true, rateLimit: adminWrites },
    handler: async (request, reply) => {
      await targets.deleteTarget(ctx(request), request.params.id);
      return reply.code(204).send(null);
    },
  });
  r.post('/api/v1/targets/:id/host-keys', {
    schema: {
      tags: ['targets'],
      params: TargetIdParams,
      body: AddHostKeyRequest,
      response: { 201: Target, ...errors },
    },
    config: { permission: 'target:admin', audit: true, rateLimit: adminWrites },
    handler: async (request, reply) =>
      reply.code(201).send(await targets.addHostKey(ctx(request), request.params.id, request.body)),
  });
  r.delete('/api/v1/targets/:id/host-keys/:keyId', {
    schema: { tags: ['targets'], params: HostKeyParams, response: { 200: Target, ...errors } },
    config: { permission: 'target:admin', audit: true, rateLimit: adminWrites },
    handler: async (request) => targets.revokeHostKey(ctx(request), request.params.id, request.params.keyId),
  });

  // ── remote sessions ──
  r.post('/api/v1/targets/:id/sessions', {
    schema: {
      tags: ['sessions'],
      params: TargetIdParams,
      body: OpenSessionRequest,
      response: { 201: OpenSessionResponse, ...errors },
    },
    // The kind's own permission (remote:connect / file_read / execute) is checked by the policy decision.
    config: { permission: 'target:list', audit: true, rateLimit: sessionOpens },
    handler: async (request, reply) =>
      reply
        .code(201)
        .header('cache-control', 'no-store')
        .send(await sessions.open(ctx(request), request.params.id, request.body, ticketBinding(request))),
  });
  r.get('/api/v1/sessions', {
    schema: { tags: ['sessions'], response: { 200: RemoteSessionList, ...errors } },
    config: { permission: 'authenticated', audit: false, rateLimit: reads },
    handler: async (request) => ({ items: await sessions.listMine(ctx(request)) }),
  });
  r.delete('/api/v1/sessions/:id', {
    schema: { tags: ['sessions'], params: SessionIdParams, response: { 200: RemoteSession, ...errors } },
    config: { permission: 'authenticated', audit: true, rateLimit: adminWrites },
    handler: async (request) => sessions.close(ctx(request), request.params.id),
  });

  // ── internal: broker → control plane (service token; never a browser) ──
  r.post('/internal/v1/tickets::redeem', {
    schema: {
      tags: ['internal'],
      body: RedeemTicketRequest,
      response: { 200: RedeemTicketResponse, ...errors },
    },
    config: { permission: 'internal', audit: false, rateLimit: { max: 600, timeWindow: '1 minute' } },
    handler: async (request) => sessions.redeem(request.body.ticket, request.body.origin),
  });
  r.post('/internal/v1/sessions/:id/state', {
    schema: {
      tags: ['internal'],
      params: SessionIdParams,
      body: SessionStateReport,
      response: { 200: z.object({ state: z.string() }), ...errors },
    },
    config: { permission: 'internal', audit: true, rateLimit: { max: 1200, timeWindow: '1 minute' } },
    handler: async (request) => sessions.reportState(request.params.id, request.body),
  });
  r.post('/internal/v1/brokers/:instance/started', {
    schema: {
      tags: ['internal'],
      params: BrokerInstanceParams,
      response: { 200: z.object({ closed: z.number() }), ...errors },
    },
    config: { permission: 'internal', audit: true, rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request) => sessions.brokerStarted(request.params.instance),
  });
}
