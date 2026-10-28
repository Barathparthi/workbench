import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  BrokerFsParams,
  BrokerFsRequest,
  DESKTOP_TICKET_ORIGIN,
  MAX_MESSAGE_BYTES,
  QEWS_PROTOCOL,
  REMOTE_FILE_LIMITS,
  ticketFromProtocols,
} from '@qe/contracts';
import { DomainError, fileOperation, isDomainError, type SessionRegistry } from '@qe/broker-core';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { z } from 'zod';

import type { FilesSessions } from './files-sessions.js';
import type { RunnerDeps } from './session-runner.js';
import { runTerminalSession } from './session-runner.js';

export interface BrokerDeps extends RunnerDeps {
  readonly registry: SessionRegistry;
  readonly files: FilesSessions;
  readonly allowedOrigins: readonly string[];
  readonly internalToken: string;
  readonly maxSessions: number;
  /**
   * `starting`: the control plane has not yet closed the sessions of this instance's previous run; no session may be
   * opened until it has, or that late sweep could close it.
   */
  readonly state: { shuttingDown: boolean; starting: boolean };
  readonly build?: { version: string; commit: string };
  readonly logger?: boolean | object;
}

const STREAM_PATH =
  /^\/api\/v1\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/stream$/;
const Uuid = z.object({ id: z.uuid() });
const sha = (v: string) => createHash('sha256').update(v).digest();
/** A 10 MB write as base64 plus the snapshot around it. */
const FS_BODY_LIMIT = Math.ceil(REMOTE_FILE_LIMITS.maxFileBytes / 3) * 4 + 128 * 1024;

/**
 * The broker's HTTP surface: health, internal close/revoke (service token only) and the `qews.v1` WebSocket stream
 * (Phase 08 §8.3–8.4). Nothing here is reachable without either the service token or a single-use ticket.
 */
export async function buildBroker(deps: BrokerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024, trustProxy: false });
  const tokenHash = sha(deps.internalToken);
  const allowedOrigins = new Set(deps.allowedOrigins.map((o) => new URL(o).origin));

  const internal = async (request: { headers: { authorization?: string | undefined } }) => {
    const presented = /^Bearer (\S{1,512})$/.exec(request.headers.authorization ?? '')?.[1];
    if (presented === undefined || !timingSafeEqual(sha(presented), tokenHash)) {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    }
    await Promise.resolve();
  };

  // Internal callers get the API code (and safe details) of a failure; never paths, contents or server text.
  app.setErrorHandler((error, _request, reply) => {
    if (isDomainError(error)) {
      return reply
        .code(error.httpStatus)
        .send({ code: error.code, ...(error.details !== undefined && { details: error.details }) });
    }
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_REQUEST' });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) deps.log.warn({ err: error }, 'internal request failed');
    const code =
      status === 401
        ? 'AUTH_REQUIRED'
        : status === 404
          ? 'NOT_FOUND'
          : status < 500
            ? 'INVALID_REQUEST'
            : 'INTERNAL_ERROR';
    return reply.code(status).send({ code });
  });

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/readyz', (_req, reply) =>
    deps.state.shuttingDown
      ? reply.code(503).send({ status: 'shutting-down' })
      : deps.state.starting
        ? reply.code(503).send({ status: 'starting' })
        : { status: 'ready', sessions: deps.registry.size + deps.files.size },
  );
  app.get('/version', () => deps.build ?? { version: '0.0.0-dev', commit: 'unknown' });

  app.post('/internal/v1/sessions/:id/close', { onRequest: internal }, (request) => {
    const { id } = Uuid.parse(request.params);
    const terminal = deps.registry.close(id, 'revoked');
    return { closed: deps.files.close(id, 'revoked') || terminal };
  });
  app.post('/internal/v1/users/:id/close-all', { onRequest: internal }, (request) => {
    const { id } = Uuid.parse(request.params);
    return { closed: deps.registry.closeUser(id, 'revoked') + deps.files.closeUser(id, 'revoked') };
  });

  // Remote files (Phase 09): the control plane has checked ownership, policy and capability, and sends the session
  // snapshot with every operation; the first one opens the session's SFTP connection here.
  app.post(
    '/internal/v1/sessions/:id/fs/:op',
    { onRequest: internal, bodyLimit: FS_BODY_LIMIT },
    async (request) => {
      const { id, op } = BrokerFsParams.parse(request.params);
      const { snapshot, request: body } = BrokerFsRequest.parse(request.body);
      if (snapshot.sessionId !== id || snapshot.kind !== 'files') {
        throw new DomainError('INVALID_REQUEST', 'snapshot does not match the session');
      }
      if (deps.state.shuttingDown || deps.state.starting) {
        throw new DomainError('SSH_UNREACHABLE', 'this broker is not accepting sessions');
      }
      const work = fileOperation(op, body);
      if (!deps.files.has(id) && deps.registry.size + deps.files.size >= deps.maxSessions) {
        throw new DomainError('SSH_UNREACHABLE', 'this broker is at capacity');
      }
      return deps.files.run(snapshot, work);
    },
  );

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    // Only qews.v1 is ever selected; the ticket subprotocol is consumed, never echoed back.
    handleProtocols: (protocols) => (protocols.has(QEWS_PROTOCOL) ? QEWS_PROTOCOL : false),
  });

  const refuse = (socket: Duplex, status: number, text: string) => {
    socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`, () =>
      socket.destroy(),
    );
  };

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const match = STREAM_PATH.exec(new URL(req.url ?? '/', 'http://broker').pathname);
      if (match?.[1] === undefined) {
        refuse(socket, 404, 'Not Found');
        return;
      }
      if (deps.state.shuttingDown || deps.state.starting) {
        refuse(socket, 503, 'Service Unavailable');
        return;
      }
      // Browsers always send Origin on WebSockets, and it must be the IDE's (CSWSH, 07_SECURITY T12); `null` and
      // file:// pages never qualify (R17). No Origin at all is the desktop app (PHASE_10 §10.4): its ticket was issued
      // to a bearer token and bound to DESKTOP_TICKET_ORIGIN, which no browser ticket ever is.
      const presented = req.headers.origin;
      if (presented !== undefined && !allowedOrigins.has(presented)) {
        refuse(socket, 403, 'Forbidden');
        return;
      }
      const origin = presented ?? DESKTOP_TICKET_ORIGIN;
      const ticket = ticketFromProtocols(req.headers['sec-websocket-protocol']);
      if (ticket === undefined) {
        refuse(socket, 401, 'Unauthorized');
        return;
      }
      if (deps.registry.size + deps.files.size >= deps.maxSessions) {
        refuse(socket, 503, 'Service Unavailable');
        return;
      }

      let snapshot;
      try {
        snapshot = await deps.controlPlane.redeem(ticket, origin);
      } catch (error) {
        refuse(
          socket,
          isDomainError(error) && error.code === 'TARGET_NOT_ALLOWED' ? 403 : 401,
          'Unauthorized',
        );
        return;
      }
      // The ticket must belong to the session in the path, and be for a terminal.
      if (snapshot.sessionId !== match[1] || snapshot.kind !== 'terminal') {
        refuse(socket, 401, 'Unauthorized');
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const bridge = runTerminalSession(
          {
            send: (data) => {
              if (ws.readyState === ws.OPEN) ws.send(data);
            },
            close: (code, reason) => {
              ws.close(code, reason);
            },
            get bufferedAmount() {
              return ws.bufferedAmount;
            },
          },
          snapshot,
          deps,
        );
        ws.on('message', (data: RawData, isBinary: boolean) => {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          bridge.handleMessage(isBinary ? bytes : bytes.toString('utf8'), isBinary);
        });
        ws.on('close', () => {
          bridge.close('client_closed');
        });
        ws.on('error', () => {
          bridge.close('client_closed');
        });
      });
    })().catch((error: unknown) => {
      deps.log.warn({ err: error }, 'stream upgrade failed');
      refuse(socket, 500, 'Internal Server Error');
    });
  });

  app.addHook('onClose', () => {
    deps.registry.closeAll('shutdown');
    deps.files.closeAll('shutdown');
    wss.close();
  });
  return app;
}
