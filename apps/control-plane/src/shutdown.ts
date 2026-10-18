import type { FastifyInstance } from 'fastify';

import type { ReadinessState } from './routes/health.js';

/**
 * SIGTERM sequence (03 §3.9): report not-ready first, stop accepting and drain within the grace period,
 * then release the database. If draining overruns the grace period the process is ended anyway.
 */
export function createShutdown(
  app: FastifyInstance,
  state: ReadinessState,
  closeDatabase: () => Promise<void>,
  graceMs: number,
  exit: (code: number) => void = (code) => process.exit(code),
): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => {
    running ??= (async () => {
      state.shuttingDown = true;
      app.log.info({ graceMs }, 'shutting down');
      const force = setTimeout(() => {
        app.log.error({ graceMs }, 'shutdown grace period exceeded');
        exit(1);
      }, graceMs);
      force.unref();
      try {
        await app.close();
        await closeDatabase();
        clearTimeout(force);
        exit(0);
      } catch (error) {
        app.log.error({ err: error }, 'shutdown failed');
        clearTimeout(force);
        exit(1);
      }
    })();
    return running;
  };
}
