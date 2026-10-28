import { createHash } from 'node:crypto';

import { rolesForGroups, type RoleMappings } from '@qe/rbac';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Kysely } from 'kysely';

import { writeAuditEvent } from '../audit/audit-writer.js';
import {
  makePrincipal,
  type Authenticated,
  type AuthInput,
  type Authenticator,
  type Principal,
} from '../auth.js';
import type { Database } from '../db/schema.js';
import { UsersRepo } from '../repos/users.js';
import { isUniqueViolation } from '../repos/workspaces.js';
import { identityFromClaims, LoginError, type OidcIdentity } from './oidc.js';

/** What a desktop access token must be (PHASE_10 §10.4). */
export interface AccessTokenExpectations {
  readonly issuer: string;
  /** The API's audience: the IdP adds it to the desktop client's tokens. */
  readonly audience: string;
  /** The desktop app's public client: the token's `azp`. Tokens issued to any other client are refused. */
  readonly clientId: string;
  readonly groupsClaim: string;
}

export interface VerifiedAccessToken {
  readonly identity: OidcIdentity;
  /** The IdP session (`sid`) the token belongs to, or the token's hash: one audited sign-in per key. */
  readonly signInKey: string;
  readonly expiresAtMs: number;
}

/** Asymmetric signatures only: `none` and HMAC (a shared secret the client could know) are never accepted. */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'EdDSA'];
/** Access tokens are short lived; one valid for longer than this is refused rather than trusted for long. */
const MAX_LIFETIME_SEC = 3600;
const CLOCK_TOLERANCE_SEC = 30;
/** RFC 6750 b64token, with a bound. */
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]{16,8192}=*)$/;

/** The token in an `Authorization: Bearer …` header, or `undefined` when there is none or it is malformed. */
export const bearerToken = (header: string | undefined): string | undefined =>
  header === undefined ? undefined : BEARER.exec(header)?.[1];

const hash = (token: string): string => createHash('sha256').update(token).digest('base64url');

/**
 * Checks an access token: signature against the IdP's keys, issuer, audience, authorized party, expiry (with a
 * bounded lifetime) and type; then maps its claims like an ID token's. Throws on anything else.
 */
export async function verifyAccessToken(
  token: string,
  keys: JWTVerifyGetKey,
  expected: AccessTokenExpectations,
  now: Date = new Date(),
): Promise<VerifiedAccessToken> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: expected.issuer,
    audience: expected.audience,
    algorithms: ALGORITHMS,
    clockTolerance: CLOCK_TOLERANCE_SEC,
    currentDate: now,
    requiredClaims: ['exp', 'iat', 'sub', 'azp'],
  });
  if (payload.azp !== expected.clientId) throw new LoginError('invalid_claims');
  // Keycloak types its tokens; an ID or refresh token is never a bearer credential.
  if (payload['typ'] !== undefined && payload['typ'] !== 'Bearer') throw new LoginError('invalid_claims');
  const exp = payload.exp ?? 0;
  const iat = payload.iat ?? 0;
  if (exp - iat > MAX_LIFETIME_SEC) throw new LoginError('invalid_claims');
  const sid = payload['sid'];
  return {
    identity: identityFromClaims(payload, expected.groupsClaim),
    signInKey: typeof sid === 'string' && sid.length > 0 && sid.length <= 256 ? `sid:${sid}` : hash(token),
    expiresAtMs: exp * 1000,
  };
}

/** The IdP's keys, fetched on demand and cached (a key the cache does not know triggers one refetch). */
export function remoteKeys(jwksUri: () => Promise<URL>): JWTVerifyGetKey {
  let keys: Promise<JWTVerifyGetKey> | undefined;
  return async (header, token) => {
    keys ??= jwksUri().then(
      (uri) => createRemoteJWKSet(uri, { timeoutDuration: 10_000, cooldownDuration: 30_000 }),
      (error: unknown) => {
        keys = undefined; // discovery failed: retry on the next request
        throw error;
      },
    );
    return (await keys)(header, token);
  };
}

export interface BearerAuthSettings extends AccessTokenExpectations {
  readonly roleMappings: RoleMappings;
}

/** Bounded memory of recent tokens and sign-ins; the oldest entries go first. */
const MAX_REMEMBERED = 5000;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Desktop bearer authentication (PHASE_10 §10.4, decision 3): an access token of the desktop client becomes the same
 * principal a browser login would — the user is created or refreshed from its claims and its groups are mapped to
 * roles. The first token of each IdP session is audited as a sign-in (`desktop_token`); later tokens of that session
 * only refresh the user. A disabled user is refused on every request, cached token or not.
 */
export function createBearerAuth(
  db: Kysely<Database>,
  keys: JWTVerifyGetKey,
  settings: BearerAuthSettings,
  now: () => Date = () => new Date(),
) {
  /** token hash → user, until the token expires: no writes for every request of a token. */
  const tokens = new Map<string, { userId: string; expiresAtMs: number }>();
  /** sign-in key → expiry of its latest token: audited once. */
  const signIns = new Map<string, number>();

  const audit = (
    result: { ok: true; userId: string; roles: string[] } | { ok: false; reason: LoginError['reason'] },
    requestId: string,
  ) =>
    db.transaction().execute((tx) =>
      writeAuditEvent(
        tx,
        result.ok
          ? {
              action: 'AUTH_LOGIN_SUCCESS',
              actorType: 'user',
              actorUserId: result.userId,
              resourceType: 'access_token',
              resourceId: null,
              result: 'success',
              requestId,
              metadata: { method: 'desktop_token', roles: result.roles },
            }
          : {
              action: 'AUTH_LOGIN_FAILURE',
              actorType: 'user',
              actorUserId: null,
              resourceType: 'access_token',
              resourceId: null,
              result: 'failure',
              reasonCode: result.reason,
              requestId,
              metadata: { reason: result.reason },
            },
      ),
    );

  /** Creates or refreshes the user of a newly seen token; audits the sign-in once. */
  const signIn = async (verified: VerifiedAccessToken, requestId: string): Promise<string> => {
    const roles = rolesForGroups(verified.identity.groups, settings.roleMappings);
    const firstOfSession = !signIns.has(verified.signInKey);
    const userId = await db.transaction().execute(async (tx) => {
      const users = new UsersRepo(tx);
      const user = await users.upsertLogin(verified.identity, firstOfSession);
      if (user.status !== 'active') throw new LoginError('user_disabled');
      await users.replaceIdpRoles(user.id, roles);
      return user.id;
    });
    if (firstOfSession)
      await audit({ ok: true, userId, roles: await new UsersRepo(db).rolesOf(userId) }, requestId);
    remember(signIns, verified.signInKey, verified.expiresAtMs);
    return userId;
  };

  return async (token: string, requestId: string): Promise<Principal | undefined> => {
    let verified: VerifiedAccessToken;
    try {
      verified = await verifyAccessToken(token, keys, settings, now());
    } catch (error) {
      // A token we issued but whose claims are unusable is worth an audit; forged or expired ones are not.
      if (error instanceof LoginError) await audit({ ok: false, reason: error.reason }, requestId);
      return undefined;
    }

    const key = hash(token);
    let userId = tokens.get(key)?.userId;
    if (userId === undefined) {
      try {
        userId = await signIn(verified, requestId);
      } catch (error) {
        if (error instanceof LoginError) {
          await audit({ ok: false, reason: error.reason }, requestId);
          return undefined;
        }
        if (isUniqueViolation(error)) {
          await audit({ ok: false, reason: 'username_conflict' }, requestId);
          return undefined;
        }
        throw error;
      }
      remember(tokens, key, { userId, expiresAtMs: verified.expiresAtMs });
    }

    const users = new UsersRepo(db);
    const user = await users.findById(userId);
    if (user?.status !== 'active') {
      tokens.delete(key);
      return undefined;
    }
    return makePrincipal({
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      email: user.email,
      roles: await users.rolesOf(user.id),
    });
  };
}

/**
 * `base` (browser sessions), plus desktop bearer tokens: a request with an Authorization header is judged on that
 * header alone — a bad token is a 401, never a fallback to a cookie the same request may carry.
 */
export function withBearerTokens<A extends Authenticator>(
  base: A,
  bearer: (token: string, requestId: string) => Promise<Principal | undefined>,
): A {
  return {
    ...base,
    async authenticate(input: AuthInput): Promise<Authenticated | undefined> {
      if (input.authorization === undefined) return base.authenticate(input);
      const token = bearerToken(input.authorization);
      const principal = token === undefined ? undefined : await bearer(token, input.requestId);
      return principal === undefined ? undefined : { kind: 'bearer', principal };
    },
  };
}
