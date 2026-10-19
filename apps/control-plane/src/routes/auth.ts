import { CallbackQuery, LoginQuery, Me, ProblemDetails } from '@qe/contracts';
import { DomainError } from '@qe/domain';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { principalOf } from '../auth.js';
import { LoginError } from '../auth/oidc.js';
import {
  CSRF_COOKIE,
  LOGIN_COOKIE,
  LOGIN_TRANSACTION_MS,
  SESSION_COOKIE,
  type LoginTransaction,
  type SessionAuth,
} from '../auth/session-auth.js';

/** 07_SECURITY §4.5: authentication endpoints are limited per client. */
const authLimit = { max: 20, timeWindow: '1 minute' };
const errors = { 400: ProblemDetails, 401: ProblemDetails, 403: ProblemDetails };

const Transaction = z.strictObject({
  state: z.string().min(1).max(256),
  nonce: z.string().min(1).max(256),
  codeVerifier: z.string().min(43).max(128),
  returnTo: z.string().startsWith('/').max(2048),
  expiresAt: z.number().int(),
});

export interface AuthRouteOptions {
  readonly auth: SessionAuth;
  readonly redirectUrl: string;
  readonly publicOrigin: string;
  readonly cookieSecure: boolean;
  /** Called after a logout, e.g. to close the session's proxied WebSockets. */
  readonly onLogout?: (sessionId: string) => void;
}

function readTransaction(request: FastifyRequest): LoginTransaction | undefined {
  const raw = request.cookies[LOGIN_COOKIE];
  if (raw === undefined) return undefined;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid) return undefined;
  try {
    const parsed = Transaction.safeParse(
      JSON.parse(Buffer.from(unsigned.value, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** OIDC login, callback and logout (Phase 04 §4.2). Registered only when AUTH_MODE=oidc. */
export function authRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base: CookieSerializeOptions = { httpOnly: true, secure: options.cookieSecure, sameSite: 'lax' };
  const loginCookie: CookieSerializeOptions = { ...base, path: '/auth', signed: true };

  const clearSession = (reply: FastifyReply) =>
    reply
      .clearCookie(SESSION_COOKIE, { ...base, path: '/' })
      .clearCookie(CSRF_COOKIE, { ...base, httpOnly: false, path: '/' });

  r.get('/auth/login', {
    schema: { tags: ['auth'], querystring: LoginQuery, response: errors },
    config: { permission: 'public', audit: false, rateLimit: authLimit },
    handler: async (request, reply) => {
      const { redirectUrl, transaction } = await options.auth.startLogin(request.query.returnTo);
      const value = Buffer.from(JSON.stringify(transaction)).toString('base64url');
      return reply
        .setCookie(LOGIN_COOKIE, value, { ...loginCookie, maxAge: LOGIN_TRANSACTION_MS / 1000 })
        .header('cache-control', 'no-store')
        .redirect(redirectUrl, 302);
    },
  });

  r.get('/auth/callback', {
    schema: { tags: ['auth'], querystring: CallbackQuery, response: errors },
    config: { permission: 'public', audit: true, rateLimit: authLimit },
    handler: async (request, reply) => {
      const transaction = readTransaction(request);
      reply.clearCookie(LOGIN_COOKIE, loginCookie);
      // openid-client validates the response against the exact redirect URI, with every parameter the IdP sent.
      const callbackUrl = new URL(options.redirectUrl);
      callbackUrl.search = new URL(request.url, 'http://callback.invalid').search;
      try {
        const issued = await options.auth.finishLogin({
          callbackUrl,
          transaction,
          idpError: request.query.error !== undefined,
          requestId: request.id,
        });
        return await reply
          .setCookie(SESSION_COOKIE, issued.token, { ...base, path: '/', maxAge: issued.maxAgeSec })
          // Readable by the IDE so it can echo it in x-csrf-token (double submit, bound to the session).
          .setCookie(CSRF_COOKIE, issued.csrfToken, {
            ...base,
            httpOnly: false,
            path: '/',
            maxAge: issued.maxAgeSec,
          })
          .header('cache-control', 'no-store')
          .redirect(`${options.publicOrigin}${issued.returnTo}`, 303);
      } catch (error) {
        if (error instanceof LoginError) {
          request.log.warn({ reason: error.reason }, 'login failed');
          throw new DomainError('AUTH_REQUIRED', 'sign-in failed; start again');
        }
        throw error;
      }
    },
  });

  r.post('/auth/logout', {
    schema: { tags: ['auth'], response: { 204: z.null(), ...errors } },
    config: { permission: 'authenticated', audit: true, rateLimit: authLimit },
    handler: async (request, reply) => {
      if (request.webSession !== undefined) {
        await options.auth.logout(request.webSession, request.id);
        options.onLogout?.(request.webSession.sessionId);
      }
      return clearSession(reply).code(204).send(null);
    },
  });
}

/** `GET /api/v1/me` — in every auth mode. */
export function meRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get('/api/v1/me', {
    schema: { tags: ['auth'], response: { 200: Me, 401: ProblemDetails } },
    config: { permission: 'authenticated', audit: false, rateLimit: { max: 120, timeWindow: '1 minute' } },
    handler: (request) => {
      const p = principalOf(request);
      return {
        id: p.userId,
        username: p.username,
        displayName: p.displayName,
        email: p.email ?? null,
        roles: [...p.roles],
        permissions: [...p.permissions].sort(),
      };
    },
  });
}
