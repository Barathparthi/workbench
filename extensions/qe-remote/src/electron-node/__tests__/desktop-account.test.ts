import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DesktopAccount, DesktopSignInError } from '../desktop-account';
import { DesktopHostFailure, type DesktopHostClient } from '../desktop-host-client';

/** The control plane and the IdP, faked on one local server; PKCE is checked for real. */
interface Idp {
  base: string;
  challenges: Map<string, { challenge: string; redirectUri: string }>;
  refreshTokens: Set<string>;
  revoked: string[];
  issued: number;
  /** Overrides for misbehaving servers. */
  issuer?: string;
  desktopConfig?: number;
}
const idp: Idp = { base: '', challenges: new Map(), refreshTokens: new Set(), revoked: [], issued: 0 };
let server: Server;

const body = (req: IncomingMessage) =>
  new Promise<URLSearchParams>((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      resolve(new URLSearchParams(raw));
    });
  });
const json = (res: ServerResponse, status: number, value: unknown): ServerResponse =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const tokens = () => {
  idp.issued += 1;
  const refresh = `rt-${String(idp.issued)}`;
  idp.refreshTokens.add(refresh);
  return {
    access_token: `at-${String(idp.issued)}`,
    token_type: 'Bearer',
    expires_in: 300,
    refresh_token: refresh,
  };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', idp.base);
      const issuer = `${idp.base}/idp`;
      switch (`${req.method ?? ''} ${url.pathname}`) {
        case 'GET /auth/desktop':
          if (idp.desktopConfig !== undefined) return json(res, idp.desktopConfig, {});
          return json(res, 200, { issuer, clientId: 'qe-workspace-desktop', scopes: 'openid profile email' });
        case 'GET /idp/.well-known/openid-configuration':
          return json(res, 200, {
            issuer: idp.issuer ?? issuer,
            authorization_endpoint: `${issuer}/auth`,
            token_endpoint: `${issuer}/token`,
            revocation_endpoint: `${issuer}/revoke`,
          });
        case 'POST /idp/token': {
          const form = await body(req);
          if (form.get('client_id') !== 'qe-workspace-desktop')
            return json(res, 401, { error: 'invalid_client' });
          if (form.get('grant_type') === 'authorization_code') {
            const pending = idp.challenges.get(form.get('code') ?? '');
            idp.challenges.delete(form.get('code') ?? '');
            const verifier = form.get('code_verifier') ?? '';
            if (
              pending === undefined ||
              createHash('sha256').update(verifier).digest('base64url') !== pending.challenge ||
              form.get('redirect_uri') !== pending.redirectUri
            ) {
              return json(res, 400, { error: 'invalid_grant' });
            }
            return json(res, 200, tokens());
          }
          const refresh = form.get('refresh_token') ?? '';
          if (form.get('grant_type') !== 'refresh_token' || !idp.refreshTokens.delete(refresh)) {
            return json(res, 400, { error: 'invalid_grant' });
          }
          return json(res, 200, tokens()); // rotated
        }
        case 'POST /idp/revoke': {
          const token = (await body(req)).get('token') ?? '';
          idp.revoked.push(token);
          idp.refreshTokens.delete(token);
          return res.writeHead(200).end();
        }
        case 'GET /api/v1/me':
          if (!/^Bearer at-\d+$/.test(req.headers.authorization ?? '')) return json(res, 401, {});
          return json(res, 200, {
            id: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70',
            username: 'bob',
            displayName: 'Bob Lab',
            email: null,
            roles: ['qe.user'],
            permissions: [],
          });
        default:
          return res.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  idp.base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  idp.challenges.clear();
  idp.refreshTokens.clear();
  idp.revoked = [];
  delete idp.issuer;
  delete idp.desktopConfig;
});

type Browser = 'complete' | 'deny' | 'ignore' | 'stray-first';

/** Electron's main process: an in-memory secret store, and a "browser" that acts on the authorization URL. */
function fakeHost(opts: { browser?: Browser; encryption?: boolean; secrets?: Map<string, string> } = {}) {
  const secrets = opts.secrets ?? new Map<string, string>();
  const opened: URL[] = [];
  const strays: number[] = [];
  const host: DesktopHostClient = {
    openExternal: (raw) => {
      const url = new URL(raw);
      opened.push(url);
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const browser = opts.browser ?? 'complete';
      void (async () => {
        if (browser === 'ignore') return;
        if (browser === 'stray-first') {
          // Another local process probing the listener cannot end the wait.
          strays.push((await fetch(`${redirect}?code=evil&state=wrong`)).status);
          strays.push((await fetch(new URL('/other', redirect))).status);
        }
        if (browser === 'deny') {
          await fetch(`${redirect}?error=access_denied&state=${state}`);
          return;
        }
        const code = `code-${String(opened.length)}`;
        idp.challenges.set(code, {
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirectUri: redirect,
        });
        await fetch(`${redirect}?code=${code}&state=${encodeURIComponent(state)}`);
      })();
      return Promise.resolve();
    },
    getSecret: (key) => Promise.resolve(secrets.get(key) ?? null),
    setSecret: (key, value) => {
      if (opts.encryption === false) return Promise.reject(new DesktopHostFailure('unavailable'));
      secrets.set(key, value);
      return Promise.resolve();
    },
    deleteSecret: (key) => {
      secrets.delete(key);
      return Promise.resolve();
    },
  };
  return { host, secrets, opened, strays };
}

const account = (
  host: DesktopHostClient | undefined,
  extra: { now?: () => number; signInTimeoutMs?: number } = {},
) => new DesktopAccount({ controlPlaneUrl: idp.base, host, ...extra });

describe('desktop sign-in (authorization code + PKCE, loopback redirect)', () => {
  it('signs in through the system browser and remembers the refresh token with the host', async () => {
    const { host, secrets, opened } = fakeHost();
    const a = account(host);
    expect(await a.status()).toEqual({ state: 'signed-out' });
    const status = await a.signIn();
    expect(status).toEqual({ state: 'signed-in', username: 'bob', displayName: 'Bob Lab', remembered: true });
    expect(JSON.stringify(status)).not.toMatch(/at-|rt-/); // the frontend never sees a token

    const auth = opened[0];
    expect(`${auth?.origin ?? ''}${auth?.pathname ?? ''}`).toBe(`${idp.base}/idp/auth`);
    expect(Object.fromEntries(auth?.searchParams ?? [])).toMatchObject({
      client_id: 'qe-workspace-desktop',
      response_type: 'code',
      code_challenge_method: 'S256',
      scope: 'openid profile email',
    });
    expect(auth?.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect([...secrets.keys()]).toEqual([`qe.refresh-token ${idp.base}`]);
    expect(await a.accessToken()).toMatch(/^at-\d+$/);
  });

  it('keeps waiting through stray requests to the loopback listener', async () => {
    const { host, strays } = fakeHost({ browser: 'stray-first' });
    expect((await account(host).signIn()).state).toBe('signed-in');
    expect(strays).toEqual([400, 404]);
  });

  it('reports a sign-in the user declined at the IdP', async () => {
    const { host, secrets } = fakeHost({ browser: 'deny' });
    await expect(account(host).signIn()).rejects.toMatchObject({ reason: 'refused' });
    expect(secrets.size).toBe(0);
  });

  it('gives up when the user never finishes in the browser', async () => {
    const { host } = fakeHost({ browser: 'ignore' });
    await expect(account(host, { signInTimeoutMs: 200 }).signIn()).rejects.toMatchObject({
      reason: 'timed_out',
    });
  });

  it('cancels the first sign-in when a second one starts', async () => {
    const { host } = fakeHost({ browser: 'ignore' });
    const a = account(host);
    const first = a.signIn();
    await new Promise((r) => setTimeout(r, 100));
    const second = a.signIn();
    await expect(first).rejects.toMatchObject({ reason: 'cancelled' });
    void second.catch(() => undefined);
    await a.signOut();
    await expect(second).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it('signs in for this run only when the OS offers no secure storage: nothing is stored', async () => {
    const { host, secrets } = fakeHost({ encryption: false });
    expect(await account(host).signIn()).toMatchObject({ state: 'signed-in', remembered: false });
    expect(secrets.size).toBe(0);
  });

  it('refreshes an expiring access token, and stores the rotated refresh token', async () => {
    let now = Date.now();
    const { host, secrets } = fakeHost();
    const a = account(host, { now: () => now });
    await a.signIn();
    const first = await a.accessToken();
    const stored = [...secrets.values()][0];
    now += 5 * 60_000;
    const second = await a.accessToken();
    expect(second).not.toBe(first);
    expect([...secrets.values()][0]).not.toBe(stored);
  });

  it('restores a remembered sign-in in a new app session', async () => {
    const { host, secrets } = fakeHost();
    await account(host).signIn();
    const restarted = account(fakeHost({ secrets }).host);
    expect(await restarted.status()).toMatchObject({ state: 'signed-in', username: 'bob', remembered: true });
  });

  it('forgets a refresh token the IdP no longer accepts', async () => {
    const { host, secrets } = fakeHost();
    await account(host).signIn();
    idp.refreshTokens.clear(); // ended at the IdP (expired, revoked, user disabled)
    const restarted = account(fakeHost({ secrets }).host);
    expect(await restarted.status()).toEqual({ state: 'signed-out' });
    expect(secrets.size).toBe(0);
    await expect(restarted.accessToken()).rejects.toMatchObject({ reason: 'sign_in_required' });
  });

  it('signs out: forgets the token here and revokes it at the IdP', async () => {
    const { host, secrets } = fakeHost();
    const a = account(host);
    await a.signIn();
    const refresh = [...secrets.values()][0];
    await a.signOut();
    expect(secrets.size).toBe(0);
    expect(idp.revoked).toEqual([refresh]);
    expect(await a.status()).toEqual({ state: 'signed-out' });
  });
});

describe('desktop sign-in refuses what it should not trust', () => {
  it('without a control plane, offers nothing', async () => {
    const a = new DesktopAccount({ controlPlaneUrl: undefined, host: fakeHost().host });
    expect(await a.status()).toEqual({ state: 'not-configured' });
    await expect(a.signIn()).rejects.toMatchObject({ reason: 'not_configured' });
  });

  it('when the control plane does not offer desktop sign-in', async () => {
    idp.desktopConfig = 404;
    await expect(account(fakeHost().host).signIn()).rejects.toMatchObject({ reason: 'idp_unavailable' });
  });

  it('an IdP whose metadata names another issuer', async () => {
    idp.issuer = 'https://evil.example/realms/qe';
    const { host, opened } = fakeHost();
    await expect(account(host).signIn()).rejects.toBeInstanceOf(DesktopSignInError);
    expect(opened).toEqual([]);
  });

  it('without the desktop host, the browser cannot be opened', async () => {
    await expect(account(undefined).signIn()).rejects.toMatchObject({ reason: 'no_browser' });
  });
});
