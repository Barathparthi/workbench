import type { Kysely } from 'kysely';

import type { OidcSettings } from '../config.js';
import type { Database } from '../db/schema.js';
import { createBearerAuth, remoteKeys, withBearerTokens } from './bearer-auth.js';
import { openIdProvider } from './oidc.js';
import { createSessionAuth, type SessionAuth } from './session-auth.js';

/**
 * AUTH_MODE=oidc: browser sessions against the IdP and, when the desktop client is configured
 * (OIDC_DESKTOP_CLIENT_ID), the desktop app's bearer access tokens too (PHASE_10 §10.4).
 */
export function oidcAuthenticator(
  db: Kysely<Database>,
  settings: OidcSettings,
  provider: ReturnType<typeof openIdProvider> = openIdProvider(settings),
): SessionAuth {
  const sessions = createSessionAuth(db, provider, settings);
  if (settings.desktop === undefined) return sessions;
  return withBearerTokens(
    sessions,
    createBearerAuth(
      db,
      remoteKeys(() => provider.jwksUri()),
      {
        issuer: settings.issuer,
        audience: settings.desktop.audience,
        clientId: settings.desktop.clientId,
        groupsClaim: settings.groupsClaim,
        roleMappings: settings.roleMappings,
      },
    ),
  );
}
