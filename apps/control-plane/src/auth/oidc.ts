import { createHash, randomBytes } from 'node:crypto';

import { DomainError } from '@qe/domain';
import * as client from 'openid-client';
import { z } from 'zod';

import type { OidcSettings } from '../config.js';

/** What the control plane needs from an ID token, validated. */
export interface OidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  /** Lowercase; later used to map SSH principals (08 §5), so it is restricted to a safe alphabet. */
  readonly username: string;
  readonly displayName: string;
  readonly email?: string | undefined;
  readonly groups: readonly string[];
}

/** One login attempt's secrets, kept in a signed HttpOnly cookie between /auth/login and /auth/callback. */
export interface LoginChecks {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

/** The IdP, behind an interface: openid-client in production, a fake in unit tests. */
export interface OidcProvider {
  authorizationUrl(checks: LoginChecks): Promise<string>;
  /** Exchanges the callback's code and validates the ID token (iss, aud, exp, nonce, state, PKCE). */
  exchange(callbackUrl: URL, checks: LoginChecks): Promise<OidcIdentity>;
}

/** Why a login failed — audited (AUTH_LOGIN_FAILURE.reason) and never shown to the user in detail. */
export class LoginError extends Error {
  constructor(
    readonly reason:
      | 'invalid_transaction'
      | 'idp_error'
      | 'token_exchange'
      | 'invalid_claims'
      | 'user_disabled'
      | 'username_conflict',
    options?: { cause?: unknown },
  ) {
    super(`login failed: ${reason}`, options);
    this.name = 'LoginError';
  }
}

const random = (): string => randomBytes(32).toString('base64url');

export const newLoginChecks = (): LoginChecks => ({
  state: random(),
  nonce: random(),
  codeVerifier: random(),
});

/** RFC 7636 S256 challenge. */
export const codeChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const Claims = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1).max(255),
  preferred_username: z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.string().regex(USERNAME)),
  name: z.string().max(200).optional(),
  email: z.email().max(254).optional(),
});

/** Maps validated ID-token claims to an identity; anything unexpected is `invalid_claims`. */
export function identityFromClaims(claims: Record<string, unknown>, groupsClaim: string): OidcIdentity {
  const parsed = Claims.safeParse(claims);
  if (!parsed.success) throw new LoginError('invalid_claims');
  const rawGroups = claims[groupsClaim];
  const groups = z
    .array(z.string().max(256))
    .max(500)
    .safeParse(rawGroups ?? []);
  if (!groups.success) throw new LoginError('invalid_claims');
  const c = parsed.data;
  return {
    issuer: c.iss,
    subject: c.sub,
    username: c.preferred_username,
    displayName: c.name ?? c.preferred_username,
    email: c.email,
    // Keycloak sends full group paths ("/qe-workspace-users") unless told otherwise; accept both.
    groups: groups.data.map((g) => (g.startsWith('/') ? g.slice(1) : g)),
  };
}

const IDP_TIMEOUT_MS = 10_000;

/** openid-client adapter. Discovery is lazy (and retried) so an IdP outage does not stop the API. */
export function openIdProvider(settings: OidcSettings): OidcProvider & {
  /** The IdP's signing keys (from discovery), to verify desktop access tokens. */
  jwksUri(): Promise<URL>;
} {
  let configuration: Promise<client.Configuration> | undefined;
  const timedFetch: client.CustomFetch = (url, options) =>
    fetch(url, { ...(options as RequestInit), signal: AbortSignal.timeout(IDP_TIMEOUT_MS) });

  const discover = (): Promise<client.Configuration> => {
    configuration ??= client
      .discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret, undefined, {
        [client.customFetch]: timedFetch,
        ...(settings.allowInsecureIssuer &&
          new URL(settings.issuer).protocol === 'http:' && {
            // Local Keycloak over plain http only: refused for production by allowInsecureIssuer.
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated only as a warning sign
            execute: [client.allowInsecureRequests],
          }),
      })
      .then((c) => {
        c[client.customFetch] = timedFetch;
        return c;
      })
      .catch((error: unknown) => {
        configuration = undefined; // retry on the next login
        throw new DomainError('INTERNAL_ERROR', 'identity provider unavailable', { cause: error });
      });
    return configuration;
  };

  return {
    async jwksUri() {
      const uri = (await discover()).serverMetadata().jwks_uri;
      if (uri === undefined)
        throw new DomainError('INTERNAL_ERROR', 'identity provider publishes no jwks_uri');
      return new URL(uri);
    },

    async authorizationUrl(checks) {
      const url = client.buildAuthorizationUrl(await discover(), {
        redirect_uri: settings.redirectUrl,
        scope: settings.scopes,
        state: checks.state,
        nonce: checks.nonce,
        code_challenge: codeChallenge(checks.codeVerifier),
        code_challenge_method: 'S256',
      });
      return url.href;
    },

    async exchange(callbackUrl, checks) {
      const config = await discover();
      let claims: Record<string, unknown> | undefined;
      try {
        const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
          pkceCodeVerifier: checks.codeVerifier,
          expectedState: checks.state,
          expectedNonce: checks.nonce,
          idTokenExpected: true,
        });
        claims = tokens.claims();
      } catch (error) {
        throw new LoginError('token_exchange', { cause: error });
      }
      if (claims === undefined) throw new LoginError('token_exchange');
      return identityFromClaims(claims, settings.groupsClaim);
    },
  };
}
