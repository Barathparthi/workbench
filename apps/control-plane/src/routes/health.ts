import type { FastifyInstance } from 'fastify';

export interface ReadinessState {
  shuttingDown: boolean;
}

export interface HealthDeps {
  readonly state: ReadinessState;
  /** Resolves when the database answers in time and migrations are current; rejects with the reason. */
  readonly checkReady: () => Promise<void>;
  readonly build: { version: string; commit: string; builtAt: string };
}

const publicRoute = {
  permission: 'public',
  audit: false,
  rateLimit: { max: 600, timeWindow: '1 minute' },
} as const;

export function healthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/healthz', { config: publicRoute }, () => ({ status: 'ok' }));

  app.get('/readyz', { config: publicRoute }, async (request, reply) => {
    if (deps.state.shuttingDown) return reply.code(503).send({ status: 'shutting-down' });
    try {
      await deps.checkReady();
      return { status: 'ready' };
    } catch (error) {
      request.log.warn({ reason: (error as Error).message }, 'not ready');
      return reply.code(503).send({ status: 'not-ready' });
    }
  });

  app.get('/version', { config: publicRoute }, () => deps.build);
}
