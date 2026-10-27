import { lookup } from 'node:dns/promises';

import {
  DomainError,
  fileDevCredentialSource,
  SessionRegistry,
  ssh2Transport,
  type CredentialSource,
} from '@qe/broker-core';
import { ZodError } from 'zod';

import { describeConfigError, loadConfig, type Config } from './config.js';
import { httpControlPlane } from './control-plane-client.js';
import { FilesSessions } from './files-sessions.js';
import { buildBroker } from './server.js';

function configOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    console.error(`connection broker cannot start: ${describeConfigError(error)}`);
    return process.exit(78);
  }
}

const config = configOrExit();
const state = { shuttingDown: false };
const registry = new SessionRegistry();

// Development: key files under DEV_CREDENTIALS_DIR (refused in production by config). Vault: Phase 12.
const credentials: CredentialSource =
  config.DEV_CREDENTIALS_DIR === undefined
    ? {
        resolve: () =>
          Promise.reject(new DomainError('CREDENTIALS_UNAVAILABLE', 'no credential source configured')),
      }
    : fileDevCredentialSource(config.DEV_CREDENTIALS_DIR);

const runner = {
  controlPlane: httpControlPlane(config.CONTROL_PLANE_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
  transport: ssh2Transport,
  credentials,
  resolver: async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  deniedCidrs: config.TARGET_DENY_CIDRS,
  registry,
  instanceId: config.BROKER_INSTANCE_ID,
  log: {
    info: (o: object, m: string) => {
      app.log.info(o, m);
    },
    warn: (o: object, m: string) => {
      app.log.warn(o, m);
    },
  },
};

const app = await buildBroker({
  ...runner,
  files: new FilesSessions(runner),
  allowedOrigins: config.ALLOWED_ORIGINS,
  internalToken: config.INTERNAL_SERVICE_TOKEN,
  maxSessions: config.MAX_SESSIONS,
  state,
  logger: {
    level: config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["sec-websocket-protocol"]'],
      censor: '[REDACTED]',
    },
  },
});

/** Drain: stop accepting, give live sessions a grace period, then close them with 4013 so clients reconnect. */
async function shutdown(): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  app.log.info({ sessions: registry.size }, 'shutting down');
  const deadline = Date.now() + config.SHUTDOWN_GRACE_MS;
  while (registry.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  await app.close();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
await app.listen({ host: config.HOST, port: config.PORT });
