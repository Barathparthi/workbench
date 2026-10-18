import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';

import { authenticate, checkOrigin, Permissions, type Principal } from './auth.js';
import type { Config } from './config.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { loggerOptions } from './logger.js';
import { requestIdFor } from './request-id.js';
import { healthRoutes, type HealthDeps } from './routes/health.js';
import { workspaceRoutes } from './routes/workspaces.js';
import type { WorkspaceService } from './workspace-service.js';

export interface ServerDeps {
  readonly workspaces: WorkspaceService;
  readonly health: HealthDeps;
  /** The acting user in AUTH_MODE=dev; undefined means no authentication mechanism (oidc before Phase 04). */
  readonly devPrincipal?: Principal | undefined;
  /** Test hook: where logs go. */
  readonly logStream?: DestinationStream;
}

const BODY_LIMIT = 1024 * 1024;
const VALID_PERMISSIONS = new Set<string>([...Permissions, 'public']);

/** CLAUDE.md rule 7, at registration: no route without a permission, an audit flag and a rate limit. */
export function assertRouteDeclarations(route: RouteOptions): void {
  if (route.url.startsWith('/documentation') || route.method === 'HEAD') return;
  const config = route.config ?? {};
  const where = `${String(route.method)} ${route.url}`;
  if (config.permission === undefined || !VALID_PERMISSIONS.has(config.permission)) {
    throw new Error(`route ${where} must declare config.permission`);
  }
  if (typeof config.audit !== 'boolean') throw new Error(`route ${where} must declare config.audit`);
  if (config.rateLimit === undefined) throw new Error(`route ${where} must declare config.rateLimit`);
}

/** Builds the API without listening (tests use app.inject). */
export async function buildServer(config: Config, deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      deps.logStream === undefined
        ? loggerOptions(config.LOG_LEVEL)
        : { ...loggerOptions(config.LOG_LEVEL), stream: deps.logStream },
    bodyLimit: BODY_LIMIT,
    genReqId: requestIdFor,
    requestIdHeader: false,
    trustProxy: false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.addHook('onRoute', assertRouteDeclarations);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(swagger, {
    openapi: {
      info: { title: 'QE Workspace control plane', version: config.BUILD_VERSION },
      servers: [{ url: config.PUBLIC_ORIGIN }],
    },
    transform: jsonSchemaTransform,
  });
  app.addHook('onRequest', checkOrigin(config.ALLOWED_ORIGINS));
  app.addHook('preHandler', authenticate(deps.devPrincipal));

  healthRoutes(app, deps.health);
  workspaceRoutes(app, deps.workspaces);
  return app;
}
