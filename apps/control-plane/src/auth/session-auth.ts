import { randomBytes } from 'node:crypto';

import type { Permission } from '@qe/rbac';
import { rolesForGroups } from '@qe/rbac';
import type { FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import { writeAuditEvent, type AuditEventInput } from '../audit/audit-writer.js';
import { makePrincipal, sha256, type Authenticator, type Principal, type ResolvedSession } from '../auth.js';
import type { OidcSettings } from '../config.js';
import type { Database } from '../db/schema.js';
import { UsersRepo } from '../repos/users.js';
import { isUniqueViolation } from '../repos/workspaces.js';
import { WebSessionsRepo } from '../repos/web-sessions.js';
import { LoginError, newLoginChecks, type LoginChecks, type OidcProvider } from './oidc.js';
import { safeReturnTo } from './return-to.js';

export const SESSION_COOKIE = 'qews_session';
export const CSRF_COOKIE = 'qews_csrf';
export const LOGIN_COOKIE = 'qews_oidc';

/** A login in progress: the OIDC checks plus where to go afterwards. Lives in a signed cookie for 10 min. */
export interface LoginTransaction extends LoginChecks {
  readonly returnTo: string;
  readonly expiresAt: number;
}
export const LOGIN_TRANSACTION_MS = 10 * 60_000;

/** Last-seen is written at most this often, so reads do not turn into a write per request. */
const TOUCH_EVERY_MS = 60_000;

export interface IssuedSession {
  readonly sessionId: string;
  /** Raw cookie values: returned once, stored only as hashes. */
  readonly token: string;
  readonly csrfToken: string;
  readonly maxAgeSec: number;
  readonly returnTo: string;
}

export interface SessionAuth extends Authenticator {
  startLogin(returnTo: unknown): Promise<{ redirectUrl: string; transaction: LoginTransaction }>;
  /** Throws LoginError on any failure, after auditing it. */
  finishLogin(input: {
    callbackUrl: URL;
    transaction: LoginTransaction | undefined;
    idpError: boolean;
    requestId: string;
  }): Promise<IssuedSession>;
  logout(session: ResolvedSession, requestId: string): Promise<void>;
}

const randomToken = (): string => randomBytes(32).toString('base64url');

export function createSessionAuth(
  db: Kysely<Database>,
  oidc: OidcProvider,
  settings: OidcSettings,
  now: () => Date = () => new Date(),
): SessionAuth {
  const audit = (event: AuditEventInput, tx?: Transaction<Database>): Promise<unknown> =>
    tx === undefined
      ? db.transaction().execute((t) => writeAuditEvent(t, event))
      : writeAuditEvent(tx, event);

  const loginFailed = async (reason: LoginError['reason'], requestId: string, cause?: unknown) => {
    await audit({
      action: 'AUTH_LOGIN_FAILURE',
      actorType: 'user',
      actorUserId: null,
      resourceType: 'web_session',
      resourceId: null,
      result: 'failure',
      reasonCode: reason,
      requestId,
      metadata: { reason },
    });
    return new LoginError(reason, { cause });
  };

  const expire = async (
    sessionId: string,
    userId: string,
    reason: 'idle' | 'absolute' | 'user_disabled',
    requestId: string,
  ) => {
    await db.transaction().execute(async (tx) => {
      if (!(await new WebSessionsRepo(tx).delete(sessionId))) return; // a parallel request already did it
      await audit(
        {
          action: 'AUTH_SESSION_EXPIRED',
          actorType: 'system',
          actorUserId: userId,
          resourceType: 'web_session',
          resourceId: sessionId,
          result: 'success',
          requestId,
          metadata: { reason },
        },
        tx,
      );
    });
  };

  return {
    async authenticate(request: FastifyRequest) {
      const token = request.cookies[SESSION_COOKIE];
      if (token === undefined || token.length === 0 || token.length > 128) return undefined;
      const row = await new WebSessionsRepo(db).findByTokenHash(sha256(token));
      if (row === undefined) return undefined;

      const at = now();
      if (row.user.status !== 'active') {
        await expire(row.id, row.userId, 'user_disabled', request.id);
        return undefined;
      }
      if (at.getTime() >= row.expiresAt.getTime()) {
        await expire(row.id, row.userId, 'absolute', request.id);
        return undefined;
      }
      if (at.getTime() - row.lastSeenAt.getTime() >= settings.idleMs) {
        await expire(row.id, row.userId, 'idle', request.id);
        return undefined;
      }
      if (at.getTime() - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
        await new WebSessionsRepo(db).touch(row.id, at);
      }

      const principal = makePrincipal({
        userId: row.userId,
        username: row.user.username,
        displayName: row.user.displayName,
        email: row.user.email,
        roles: await new UsersRepo(db).rolesOf(row.userId),
      });
      return { kind: 'session', session: { principal, sessionId: row.id, csrfHash: row.csrfHash } };
    },

    async recordDenied(request: FastifyRequest, principal: Principal, permission: Permission) {
      await audit({
        action: 'ACCESS_DENIED',
        actorType: 'user',
        actorUserId: principal.userId,
        resourceType: 'route',
        resourceId: null,
        result: 'denied',
        reasonCode: 'missing_permission',
        requestId: request.id,
        metadata: {
          permission,
          method: request.method,
          route: request.routeOptions.url ?? 'unknown',
        },
      });
    },

    async startLogin(returnTo) {
      const checks = newLoginChecks();
      const transaction: LoginTransaction = {
        ...checks,
        returnTo: safeReturnTo(returnTo),
        expiresAt: now().getTime() + LOGIN_TRANSACTION_MS,
      };
      return { redirectUrl: await oidc.authorizationUrl(checks), transaction };
    },

    async finishLogin({ callbackUrl, transaction, idpError, requestId }) {
      if (transaction === undefined || now().getTime() > transaction.expiresAt) {
        throw await loginFailed('invalid_transaction', requestId);
      }
      if (idpError) throw await loginFailed('idp_error', requestId);

      let identity;
      try {
        identity = await oidc.exchange(callbackUrl, transaction);
      } catch (error) {
        const reason = error instanceof LoginError ? error.reason : 'token_exchange';
        throw await loginFailed(reason, requestId, error);
      }

      const roles = rolesForGroups(identity.groups, settings.roleMappings);
      const token = randomToken();
      const csrfToken = randomToken();
      const sessionId = uuidv7();
      const createdAt = now();

      try {
        await db.transaction().execute(async (tx) => {
          const users = new UsersRepo(tx);
          const user = await users.upsertLogin(identity);
          if (user.status !== 'active') throw new LoginError('user_disabled');
          await users.replaceIdpRoles(user.id, roles);
          await new WebSessionsRepo(tx).insert({
            id: sessionId,
            tokenHash: sha256(token),
            csrfHash: sha256(csrfToken),
            userId: user.id,
            createdAt,
            expiresAt: new Date(createdAt.getTime() + settings.absoluteMs),
          });
          await audit(
            {
              action: 'AUTH_LOGIN_SUCCESS',
              actorType: 'user',
              actorUserId: user.id,
              resourceType: 'web_session',
              resourceId: sessionId,
              result: 'success',
              requestId,
              metadata: { method: 'oidc', roles: await users.rolesOf(user.id) },
            },
            tx,
          );
        });
      } catch (error) {
        if (error instanceof LoginError) throw await loginFailed(error.reason, requestId);
        if (isUniqueViolation(error)) throw await loginFailed('username_conflict', requestId, error);
        throw error;
      }

      return {
        sessionId,
        token,
        csrfToken,
        maxAgeSec: Math.floor(settings.absoluteMs / 1000),
        returnTo: transaction.returnTo,
      };
    },

    async logout(session, requestId) {
      await db.transaction().execute(async (tx) => {
        if (!(await new WebSessionsRepo(tx).delete(session.sessionId))) return;
        await audit(
          {
            action: 'AUTH_LOGOUT',
            actorType: 'user',
            actorUserId: session.principal.userId,
            resourceType: 'web_session',
            resourceId: session.sessionId,
            result: 'success',
            requestId,
            metadata: {},
          },
          tx,
        );
      });
    },
  };
}
