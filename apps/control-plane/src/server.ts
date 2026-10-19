import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';

import {
  authorize,
  checkOrigin,
  devAuthenticator,
  isRoutePermission,
  noAuthenticator,
  type Authenticator,
  type Principal,
} from './auth.js';
import { authRoutes, meRoutes, type AuthRouteOptions } from './routes/auth.js';
import { lifecycleRoutes } from './routes/lifecycle.js';
import { registerWorkspaceRouter, type RouteLookup } from './router/workspace-router.js';
import type { WorkspaceLifecycle } from './workspace-lifecycle.js';
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
  /** The acting user in AUTH_MODE=dev (development and tests only). */
  readonly devPrincipal?: Principal | undefined;
  /** AUTH_MODE=oidc: browser sessions and the login routes. Takes precedence over devPrincipal. */
  readonly sessions?: (AuthRouteOptions & { readonly cookieSecret: string }) | undefined;
  /** Workspace runtimes (Phase 05): lifecycle routes and the /w/{id}/ router. Absent in local mode. */
  readonly runtime?:
    | {
        readonly lifecycle: WorkspaceLifecycle;
        readonly lookup: RouteLookup;
        readonly touch: (workspaceId: string) => Promise<void>;
      }
    | undefined;
  /** Test hook: sees every registered route (the authz matrix test enumerates them). */
  readonly onRouteRegistered?: (route: RouteOptions) => void;
  /** Test hook: where logs go. */
  readonly logStream?: DestinationStream;
}

const BODY_LIMIT = 1024 * 1024;

/** CLAUDE.md rule 7, at registration: no route without a permission, an audit flag and a rate limit. */
export function assertRouteDeclarations(route: RouteOptions): void {
  if (route.url.startsWith('/documentation') || route.method === 'HEAD') return;
  const config = route.config ?? {};
  const where = `${String(route.method)} ${route.url}`;
  if (config.permission === undefined || !isRoutePermission(config.permission)) {
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
  app.addHook('onRoute', (route) => {
    assertRouteDeclarations(route);
    deps.onRouteRegistered?.(route);
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(helmet);
  // The secret signs only the short-lived login transaction cookie; session cookies are random tokens.
  await app.register(cookie, deps.sessions === undefined ? {} : { secret: deps.sessions.cookieSecret });
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
  const authenticator: Authenticator =
    deps.sessions?.auth ??
    (deps.devPrincipal === undefined ? noAuthenticator : devAuthenticator(deps.devPrincipal));
  // onRequest: refuse unauthenticated or unauthorized callers before their body is even parsed.
  app.addHook('onRequest', authorize(authenticator));

  healthRoutes(app, deps.health);
  meRoutes(app);
  workspaceRoutes(app, deps.workspaces);

  let closeSession: ((sessionId: string) => void) | undefined;
  if (deps.runtime !== undefined) {
    lifecycleRoutes(app, deps.runtime.lifecycle, deps.workspaces);
    const router = await registerWorkspaceRouter(app, {
      lookup: deps.runtime.lookup,
      touch: deps.runtime.touch,
      authenticator,
      allowedOrigins: config.ALLOWED_ORIGINS,
      log: app.log,
    });
    deps.runtime.lifecycle.events.onAny((e) => {
      if (e.state !== 'RUNNING') router.closeWorkspace(e.id);
    });
    closeSession = (sessionId) => {
      router.closeSession(sessionId);
    };
  }
  if (deps.sessions !== undefined) {
    authRoutes(app, { ...deps.sessions, ...(closeSession !== undefined && { onLogout: closeSession }) });
  }
  return app;
}
