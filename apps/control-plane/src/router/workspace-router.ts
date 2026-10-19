import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';

import replyFrom from '@fastify/reply-from';
import { DomainError, type WorkspaceState } from '@qe/domain';
import type { FastifyInstance } from 'fastify';

import { principalOf, type Authenticator } from '../auth.js';
import { CSRF_COOKIE, LOGIN_COOKIE, SESSION_COOKIE } from '../auth/session-auth.js';

/** Where one workspace's IDE answers, as seen by one user (undefined: not a member, or deleted). */
export type RouteLookup = (
  workspaceId: string,
  userId: string,
) => Promise<{ state: WorkspaceState; runtime_ref: string | null } | undefined>;

export interface RouterDeps {
  readonly lookup: RouteLookup;
  /** Records activity (debounced by the router) so idle workspaces can be stopped. */
  readonly touch: (workspaceId: string) => Promise<void>;
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly log: { warn: (obj: object, msg: string) => void };
}

export interface WorkspaceRouter {
  /** Closes every proxied WebSocket of a browser session (logout, revocation). */
  closeSession(sessionId: string): void;
  /** Closes every proxied WebSocket of a workspace (stop). */
  closeWorkspace(workspaceId: string): void;
}

const PREFIX = /^\/w\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/[^?#]*)?(\?.*)?$/;
const PLATFORM_COOKIES = new Set([SESSION_COOKIE, CSRF_COOKIE, LOGIN_COOKIE]);
const TOUCH_EVERY_MS = 60_000;
const CACHE_MS = 5_000;

/** The runtime never sees platform credentials: our cookies, Authorization and the CSRF header are removed. */
export function upstreamHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers };
  delete out.authorization;
  delete out['x-csrf-token'];
  const cookie = headers.cookie;
  if (cookie !== undefined) {
    const kept = cookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && !PLATFORM_COOKIES.has(c.slice(0, Math.max(0, c.indexOf('=')))));
    if (kept.length > 0) out.cookie = kept.join('; ');
    else delete out.cookie;
  }
  return out;
}

/**
 * Theia's connection-token cookie is `Path=/`, so two workspaces in one browser would overwrite each other's
 * token (spike S2, ADR-005). Every runtime cookie is scoped to its own `/w/{id}/`.
 */
export function scopeSetCookie(value: string, workspaceId: string): string {
  const path = `/w/${workspaceId}/`;
  return /;\s*path=/i.test(value)
    ? value.replace(/;\s*path=[^;]*/i, `; Path=${path}`)
    : `${value}; Path=${path}`;
}

const rewriteSetCookie = <H extends IncomingHttpHeaders>(headers: H, workspaceId: string): H => {
  const set = headers['set-cookie'];
  if (set === undefined) return headers;
  return { ...headers, 'set-cookie': set.map((c) => scopeSetCookie(c, workspaceId)) };
};

/** Authenticated HTTP + WebSocket proxy `/w/{id}/*` → that workspace's runtime (Phase 05 §5.7). */
export async function registerWorkspaceRouter(
  app: FastifyInstance,
  deps: RouterDeps,
): Promise<WorkspaceRouter> {
  const cache = new Map<string, { endpoint: string; until: number }>();
  const touched = new Map<string, number>();
  const sockets = new Set<{
    sessionId: string | undefined;
    workspaceId: string;
    client: Duplex;
    upstream?: Duplex;
  }>();

  const touch = (workspaceId: string) => {
    const now = Date.now();
    if (now - (touched.get(workspaceId) ?? 0) < TOUCH_EVERY_MS) return;
    touched.set(workspaceId, now);
    deps.touch(workspaceId).catch((error: unknown) => {
      deps.log.warn({ err: error, workspaceId }, 'could not record workspace activity');
    });
  };

  /** The runtime endpoint, or a DomainError: 404 for non-members, 409 when not running. */
  const resolve = async (workspaceId: string, userId: string): Promise<string> => {
    const key = `${userId}:${workspaceId}`;
    const hit = cache.get(key);
    if (hit !== undefined && hit.until > Date.now()) return hit.endpoint;
    const route = await deps.lookup(workspaceId, userId);
    if (route === undefined) throw new DomainError('NOT_FOUND');
    if (route.state !== 'RUNNING' || route.runtime_ref === null) {
      throw new DomainError('WORKSPACE_NOT_READY', 'start the workspace first', {
        details: { state: route.state },
      });
    }
    cache.set(key, { endpoint: route.runtime_ref, until: Date.now() + CACHE_MS });
    return route.runtime_ref;
  };

  await app.register(async (scope) => {
    // Bodies pass through untouched: the runtime parses them, not us.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => {
      done(null, payload);
    });
    await scope.register(replyFrom, { undici: { headersTimeout: 60_000, bodyTimeout: 0 } });

    const config = {
      permission: 'workspace:read',
      audit: false,
      csrf: 'origin',
      // The IDE loads many assets on open; this is per client and generous on purpose.
      rateLimit: { max: 3000, timeWindow: '1 minute' },
    } as const;

    scope.get('/w/:id', { config }, (request, reply) => {
      const [path, query] = request.url.split('?');
      return reply.redirect(`${path ?? ''}/${query === undefined ? '' : `?${query}`}`, 308);
    });

    scope.all('/w/:id/*', { config }, async (request, reply) => {
      const match = PREFIX.exec(request.url);
      if (match?.[1] === undefined) throw new DomainError('NOT_FOUND');
      const workspaceId = match[1];
      const endpoint = await resolve(workspaceId, principalOf(request).userId);
      touch(workspaceId);
      return reply.from(`${endpoint}${match[2] ?? '/'}${match[3] ?? ''}`, {
        rewriteRequestHeaders: (_req, headers) => upstreamHeaders(headers),
        rewriteHeaders: (headers) => rewriteSetCookie(headers, workspaceId),
      });
    });
  });

  const allowed = new Set(deps.allowedOrigins.map((o) => new URL(o).origin));
  const refuse = (socket: Duplex, status: number, text: string) => {
    socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`, () =>
      socket.destroy(),
    );
  };

  // WebSocket upgrades bypass Fastify's routing, so the same checks are repeated here.
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const match = PREFIX.exec(req.url ?? '');
      if (match?.[1] === undefined) {
        refuse(socket, 404, 'Not Found');
        return;
      }
      const workspaceId = match[1];
      const origin = req.headers.origin;
      if (origin === undefined || !allowed.has(origin)) {
        refuse(socket, 403, 'Forbidden');
        return;
      }

      const auth = await deps.authenticator.authenticate({
        cookies: app.parseCookie(req.headers.cookie ?? ''),
        requestId: randomUUID(),
      });
      if (auth === undefined) {
        refuse(socket, 401, 'Unauthorized');
        return;
      }
      const principal = auth.kind === 'dev' ? auth.principal : auth.session.principal;
      if (!principal.permissions.has('workspace:read')) {
        refuse(socket, 403, 'Forbidden');
        return;
      }

      let endpoint: string;
      try {
        endpoint = await resolve(workspaceId, principal.userId);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'NOT_FOUND') refuse(socket, 404, 'Not Found');
        else refuse(socket, 409, 'Conflict');
        return;
      }
      touch(workspaceId);

      const target = new URL(endpoint);
      const entry = {
        sessionId: auth.kind === 'session' ? auth.session.sessionId : undefined,
        workspaceId,
        client: socket,
      } as { sessionId: string | undefined; workspaceId: string; client: Duplex; upstream?: Duplex };
      const upstreamReq = httpRequest({
        hostname: target.hostname,
        port: target.port,
        method: 'GET',
        path: `${match[2] ?? '/'}${match[3] ?? ''}`,
        headers: { ...upstreamHeaders(req.headers), host: target.host },
        timeout: 15_000,
      });
      upstreamReq.on('upgrade', (res, upstream, upstreamHead) => {
        const lines = [`HTTP/1.1 101 ${res.statusMessage ?? 'Switching Protocols'}`];
        const headers = rewriteSetCookie(res.headers, workspaceId);
        for (const [k, v] of Object.entries(headers)) {
          for (const value of Array.isArray(v) ? v : [v])
            if (value !== undefined) lines.push(`${k}: ${value}`);
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        if (head.length > 0) upstream.write(head);
        entry.upstream = upstream;
        sockets.add(entry);
        const close = () => {
          sockets.delete(entry);
          socket.destroy();
          upstream.destroy();
        };
        upstream.on('data', () => {
          touch(workspaceId);
        });
        upstream.on('error', close).on('close', close);
        socket.on('error', close).on('close', close);
        upstream.pipe(socket).pipe(upstream);
      });
      upstreamReq.on('response', (res) => {
        refuse(socket, res.statusCode ?? 502, res.statusMessage ?? 'Bad Gateway');
        res.resume();
      });
      upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
      upstreamReq.on('error', () => {
        refuse(socket, 502, 'Bad Gateway');
      });
      upstreamReq.end();
    })().catch((error: unknown) => {
      deps.log.warn({ err: error }, 'workspace websocket proxy failed');
      refuse(socket, 500, 'Internal Server Error');
    });
  });

  const closeWhere = (predicate: (e: { sessionId: string | undefined; workspaceId: string }) => boolean) => {
    for (const e of [...sockets]) {
      if (!predicate(e)) continue;
      sockets.delete(e);
      e.client.destroy();
      e.upstream?.destroy();
    }
  };

  // Shutdown: proxied WebSockets would otherwise keep server.close() waiting.
  app.addHook('onClose', () => {
    closeWhere(() => true);
  });

  return {
    closeSession: (sessionId) => {
      closeWhere((e) => e.sessionId === sessionId);
    },
    closeWorkspace: (workspaceId) => {
      for (const key of [...cache.keys()]) if (key.endsWith(`:${workspaceId}`)) cache.delete(key);
      closeWhere((e) => e.workspaceId === workspaceId);
    },
  };
}
