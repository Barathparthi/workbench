import { createHash, randomBytes } from 'node:crypto';
import { createServer, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DesktopAuthConfig, Me } from '@qe/contracts';
import { z } from 'zod';

import type { DesktopAccountService, DesktopAccountStatus } from '../common/desktop-account-protocol';
import { DesktopHostFailure, type DesktopHostClient } from './desktop-host-client';

/** A failure the user sees as is: never a token, a server body or other detail. */
export class DesktopSignInError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'not_configured'
      | 'idp_unavailable'
      | 'cancelled'
      | 'timed_out'
      | 'refused'
      | 'sign_in_required'
      | 'no_browser',
  ) {
    super(message);
    this.name = 'DesktopSignInError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https, or plain http to this machine only (a local IdP in development). */
const secureUrl = z.url().refine((raw) => {
  const url = new URL(raw);
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}, 'must be https');

const ProviderMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: secureUrl,
  token_endpoint: secureUrl,
  revocation_endpoint: secureUrl.optional(),
});
type ProviderMetadata = z.infer<typeof ProviderMetadata>;

const TokenResponse = z.object({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(16_384).optional(),
});

const IO_TIMEOUT_MS = 10_000;
/** How long the user has to finish signing in in the browser. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;

const PAGE_HEADERS: OutgoingHttpHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
/** Fixed texts only: nothing from the request is ever reflected into the page. */
const page = (text: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>QE Workspace</title></head><body><p>${text}</p></body></html>`;

interface Callback {
  readonly redirectUri: string;
  readonly code: Promise<string>;
  cancel(): void;
}

/**
 * RFC 8252 loopback redirect: a one-shot listener on 127.0.0.1 at a port the OS picks. Only `GET /callback` with the
 * expected `state` counts; anything else is answered and ignored (another local process cannot end the wait).
 */
async function loopbackCallback(state: string, timeoutMs: number): Promise<Callback> {
  let settle: { resolve: (code: string) => void; reject: (e: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, PAGE_HEADERS).end(page('Not found.'));
      return;
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, PAGE_HEADERS).end(page('This is not the sign-in QE Workspace is waiting for.'));
      return;
    }
    const received = url.searchParams.get('code');
    if (received !== null && received.length > 0 && received.length <= 4096) {
      res
        .writeHead(200, PAGE_HEADERS)
        .end(page('Signed in. You can close this tab and go back to QE Workspace.'));
      settle?.resolve(received);
    } else {
      res
        .writeHead(200, PAGE_HEADERS)
        .end(page('Sign-in did not complete. Go back to QE Workspace to try again.'));
      settle?.reject(
        new DesktopSignInError('The sign-in was not completed at your identity provider.', 'refused'),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  const timer = setTimeout(() => {
    settle?.reject(new DesktopSignInError('The sign-in timed out. Try again.', 'timed_out'));
  }, timeoutMs);
  void code.then(close, close).finally(() => {
    clearTimeout(timer);
  });
  return {
    redirectUri: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/callback`,
    code,
    cancel: () => {
      settle?.reject(new DesktopSignInError('The sign-in was cancelled.', 'cancelled'));
    },
  };
}

interface Session {
  accessToken: string;
  expiresAtMs: number;
  refreshToken: string | undefined;
  username: string;
  displayName: string;
  remembered: boolean;
}

export interface DesktopAccountDeps {
  /** The control plane the desktop app is connected to (QE_CONTROL_PLANE_URL); none: managed targets are off. */
  readonly controlPlaneUrl: string | undefined;
  /** Electron's main process; absent when the backend was not started by it (then nothing is remembered). */
  readonly host: DesktopHostClient | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly signInTimeoutMs?: number;
}

/**
 * The desktop app's sign-in to QE Workspace (PHASE_10 §10.4): OIDC authorization code + PKCE (S256) for the IdP's
 * public desktop client, through the system browser and a loopback redirect. The access token lives in this process's
 * memory only; the refresh token is kept by Electron's main process with `safeStorage`, or — where the OS offers no
 * secure storage — in memory until the app closes. Never in plain text on disk, never in the renderer.
 */
export class DesktopAccount implements DesktopAccountService {
  protected session: Session | undefined;
  protected restored: Promise<void> | undefined;
  protected refreshing: Promise<Session> | undefined;
  protected pending: Callback | undefined;
  /** Bumped by every sign-in and sign-out: an older sign-in still under way notices and stops. */
  protected attempt = 0;
  protected readonly fetch: typeof fetch;
  protected readonly now: () => number;

  constructor(protected readonly deps: DesktopAccountDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Where the refresh token is kept: one per control plane. */
  protected get secretKey(): string {
    return `qe.refresh-token ${new URL(this.controlPlane()).origin}`;
  }

  protected controlPlane(): string {
    if (this.deps.controlPlaneUrl === undefined) {
      throw new DesktopSignInError('No QE Workspace server is configured.', 'not_configured');
    }
    return this.deps.controlPlaneUrl;
  }

  async status(): Promise<DesktopAccountStatus> {
    if (this.deps.controlPlaneUrl === undefined) return { state: 'not-configured' };
    this.restored ??= this.restore();
    await this.restored;
    return this.describe();
  }

  async signIn(): Promise<DesktopAccountStatus> {
    const attempt = this.supersede();
    const current = () => {
      if (attempt !== this.attempt) throw new DesktopSignInError('The sign-in was cancelled.', 'cancelled');
    };
    const { config, metadata } = await this.discover();
    current();
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    const callback = await loopbackCallback(state, this.deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS);
    this.pending = callback;
    try {
      current();
      const url = new URL(metadata.authorization_endpoint);
      for (const [k, v] of Object.entries({
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: callback.redirectUri,
        scope: config.scopes,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })) {
        url.searchParams.set(k, v);
      }
      if (this.deps.host === undefined) {
        throw new DesktopSignInError('The desktop app cannot open your browser.', 'no_browser');
      }
      await this.deps.host.openExternal(url.href);
      const code = await callback.code;
      const tokens = await this.tokenRequest(metadata, {
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        redirect_uri: callback.redirectUri,
        code_verifier: verifier,
      });
      const session = await this.establish(tokens, undefined);
      current();
      session.remembered = await this.remember(session.refreshToken);
      this.session = session;
      this.restored = Promise.resolve();
      return this.describe();
    } finally {
      callback.cancel();
      if (this.pending === callback) this.pending = undefined;
    }
  }

  /** Starts a new attempt: cancels the one waiting for the browser, if any. */
  protected supersede(): number {
    this.attempt += 1;
    this.pending?.cancel();
    return this.attempt;
  }

  async signOut(): Promise<void> {
    this.supersede();
    const ended = this.session;
    this.session = undefined;
    this.restored = Promise.resolve();
    await this.deps.host?.deleteSecret(this.secretKey).catch(() => undefined);
    // Best effort: end the refresh token at the IdP too.
    if (ended?.refreshToken !== undefined) {
      try {
        const { config, metadata } = await this.discover();
        if (metadata.revocation_endpoint !== undefined) {
          await this.post(metadata.revocation_endpoint, {
            client_id: config.clientId,
            token: ended.refreshToken,
            token_type_hint: 'refresh_token',
          });
        }
      } catch {
        // signed out locally either way
      }
    }
  }

  /** A valid access token for the control plane, refreshed when it is about to expire. */
  async accessToken(): Promise<string> {
    await this.status();
    const session = this.session;
    if (session === undefined)
      throw new DesktopSignInError('Sign in to QE Workspace first.', 'sign_in_required');
    if (session.expiresAtMs - EXPIRY_MARGIN_MS > this.now()) return session.accessToken;
    return (await this.refresh(session)).accessToken;
  }

  protected describe(): DesktopAccountStatus {
    const s = this.session;
    return s === undefined
      ? { state: 'signed-out' }
      : { state: 'signed-in', username: s.username, displayName: s.displayName, remembered: s.remembered };
  }

  /** A remembered sign-in: the stored refresh token, exchanged for a fresh access token. */
  protected async restore(): Promise<void> {
    const host = this.deps.host;
    if (host === undefined) return;
    let refreshToken: string | null;
    try {
      refreshToken = await host.getSecret(this.secretKey);
    } catch {
      return;
    }
    if (refreshToken === null) return;
    try {
      await this.refresh({ refreshToken, remembered: true });
    } catch {
      // refresh() forgot it if the IdP refused it; otherwise the user signs in again
    }
  }

  protected refresh(from: Pick<Session, 'refreshToken' | 'remembered'>): Promise<Session> {
    this.refreshing ??= (async () => {
      const refreshToken = from.refreshToken;
      if (refreshToken === undefined) {
        this.session = undefined;
        throw new DesktopSignInError('Your sign-in has expired. Sign in again.', 'sign_in_required');
      }
      const { config, metadata } = await this.discover();
      let tokens: z.infer<typeof TokenResponse>;
      try {
        tokens = await this.tokenRequest(metadata, {
          grant_type: 'refresh_token',
          client_id: config.clientId,
          refresh_token: refreshToken,
        });
      } catch (error) {
        if (error instanceof DesktopSignInError && error.reason === 'refused') {
          // The IdP ended the session (expired, revoked, user disabled): forget it everywhere.
          this.session = undefined;
          await this.deps.host?.deleteSecret(this.secretKey).catch(() => undefined);
          throw new DesktopSignInError('Your sign-in has expired. Sign in again.', 'sign_in_required');
        }
        throw error;
      }
      const session = await this.establish(tokens, refreshToken);
      // Rotated refresh tokens replace the stored one.
      session.remembered =
        from.remembered && session.refreshToken !== refreshToken
          ? await this.remember(session.refreshToken)
          : from.remembered;
      this.session = session;
      return session;
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Keeps the refresh token with main's safeStorage; false where the OS cannot encrypt it (kept in memory only). */
  protected async remember(refreshToken: string | undefined): Promise<boolean> {
    const host = this.deps.host;
    if (host === undefined || refreshToken === undefined) return false;
    try {
      await host.setSecret(this.secretKey, refreshToken);
      return true;
    } catch (error) {
      if (!(error instanceof DesktopHostFailure)) throw error;
      await host.deleteSecret(this.secretKey).catch(() => undefined);
      return false;
    }
  }

  /** A token response becomes a session once the control plane accepts the access token (and says who it is). */
  protected async establish(
    tokens: z.infer<typeof TokenResponse>,
    previousRefresh: string | undefined,
  ): Promise<Session> {
    const res = await this.timed(`${this.controlPlane()}/api/v1/me`, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new DesktopSignInError(
        res.status === 401
          ? 'QE Workspace did not accept this sign-in. Ask your administrator to enable desktop sign-in.'
          : 'QE Workspace cannot be reached. Try again later.',
        res.status === 401 ? 'refused' : 'idp_unavailable',
      );
    }
    const me = Me.parse(await res.json());
    return {
      accessToken: tokens.access_token,
      expiresAtMs: this.now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token ?? previousRefresh,
      username: me.username,
      displayName: me.displayName,
      remembered: false,
    };
  }

  protected discovered: Promise<{ config: DesktopAuthConfig; metadata: ProviderMetadata }> | undefined;

  /** Where to sign in, from the control plane; then the IdP's own metadata (its issuer must match exactly). */
  protected discover(): Promise<{ config: DesktopAuthConfig; metadata: ProviderMetadata }> {
    this.discovered ??= (async () => {
      const unavailable = () =>
        new DesktopSignInError(
          'Desktop sign-in is not available on this QE Workspace server.',
          'idp_unavailable',
        );
      const res = await this.timed(`${this.controlPlane()}/auth/desktop`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw unavailable();
      const config = DesktopAuthConfig.safeParse(await res.json());
      if (!config.success || !secureUrl.safeParse(config.data.issuer).success) throw unavailable();
      const issuer = config.data.issuer.replace(/\/+$/, '');
      const meta = await this.timed(`${issuer}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
      });
      if (!meta.ok) throw unavailable();
      const metadata = ProviderMetadata.safeParse(await meta.json());
      if (!metadata.success || metadata.data.issuer.replace(/\/+$/, '') !== issuer) throw unavailable();
      return { config: config.data, metadata: metadata.data };
    })().catch((error: unknown) => {
      this.discovered = undefined; // try again next time
      throw error;
    });
    return this.discovered;
  }

  protected async tokenRequest(metadata: ProviderMetadata, form: Record<string, string>) {
    const res = await this.post(metadata.token_endpoint, form);
    if (res.status === 400 || res.status === 401) {
      throw new DesktopSignInError('Your identity provider refused the sign-in. Try again.', 'refused');
    }
    if (!res.ok) throw new DesktopSignInError('Your identity provider cannot be reached.', 'idp_unavailable');
    const tokens = TokenResponse.safeParse(await res.json());
    if (!tokens.success) {
      throw new DesktopSignInError('Your identity provider sent an unusable answer.', 'idp_unavailable');
    }
    return tokens.data;
  }

  protected post(url: string, form: Record<string, string>): Promise<Response> {
    return this.timed(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  }

  protected async timed(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      });
    } catch {
      throw new DesktopSignInError(
        'QE Workspace or your identity provider cannot be reached.',
        'idp_unavailable',
      );
    }
  }
}
