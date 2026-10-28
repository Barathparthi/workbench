import { z } from 'zod';

/** `GET /api/v1/me` (05_API_CONTRACTS §2.1): who is signed in and what they may do. */
export const Me = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});
export type Me = z.infer<typeof Me>;

/** `GET /auth/login?returnTo=` — a relative path; anything else is replaced by "/" (T21). */
export const LoginQuery = z.object({ returnTo: z.string().max(2048).optional() });

/** `GET /auth/callback` — what the IdP sends back (RFC 6749 §4.1.2); extra parameters are passed through. */
export const CallbackQuery = z.looseObject({
  code: z.string().max(4096).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(256).optional(),
});

/**
 * `GET /auth/desktop` — how the desktop app signs in (PHASE_10 §10.4): an OIDC public client, authorization code with
 * PKCE through the system browser, redirected to a loopback port. Its access tokens are then sent as bearer tokens.
 */
export const DesktopAuthConfig = z.strictObject({
  issuer: z.url({ protocol: /^https?$/ }),
  clientId: z.string().min(1).max(256),
  scopes: z.string().min(1).max(512),
});
export type DesktopAuthConfig = z.infer<typeof DesktopAuthConfig>;
