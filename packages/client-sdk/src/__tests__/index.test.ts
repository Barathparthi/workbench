import { describe, expect, it, vi } from 'vitest';

import { ApiError, ControlPlaneClient, cookieValue, PACKAGE_NAME } from '../index.js';

const me = {
  id: '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d70',
  username: 'alice',
  displayName: 'Alice',
  email: null,
  roles: ['qe.user'],
  permissions: ['workspace:read'],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(response: Response, cookies = 'other=1; qews_csrf=tok%3D1') {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
  const onUnauthenticated = vi.fn<(url: string) => void>();
  const c = new ControlPlaneClient({
    baseUrl: 'https://qe.example',
    readCookies: () => cookies,
    fetch: fetchMock,
    onUnauthenticated,
    currentPath: () => '/w/1/?x=y',
  });
  return { c, fetchMock, onUnauthenticated };
}

describe('@qe/client-sdk', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qe/client-sdk');
  });

  it('reads cookies', () => {
    expect(cookieValue('a=1; qews_csrf=tok%3D1', 'qews_csrf')).toBe('tok=1');
    expect(cookieValue('a=1', 'qews_csrf')).toBeUndefined();
  });

  it('fetches /api/v1/me with credentials and no CSRF header', async () => {
    const { c, fetchMock } = client(json(200, me));
    expect(await c.me()).toEqual(me);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://qe.example/api/v1/me');
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('echoes the CSRF cookie on unsafe methods', async () => {
    const { c, fetchMock } = client(new Response(null, { status: 204 }));
    await c.logout();
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)['x-csrf-token']).toBe('tok=1');
  });

  it('turns 401 into a login redirect and an ApiError', async () => {
    const { c, onUnauthenticated } = client(
      json(401, {
        type: 't',
        title: 'Authentication required',
        status: 401,
        code: 'AUTH_REQUIRED',
        requestId: 'r',
      }),
    );
    const error = await c.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('AUTH_REQUIRED');
    expect(onUnauthenticated).toHaveBeenCalledWith(
      'https://qe.example/auth/login?returnTo=%2Fw%2F1%2F%3Fx%3Dy',
    );
  });

  it('reports non-problem errors by status', async () => {
    const { c, onUnauthenticated } = client(new Response('oops', { status: 502 }));
    const error = (await c.me().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    expect(error.code).toBeUndefined();
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it('rejects a /me body that does not match the contract', async () => {
    const { c } = client(json(200, { id: 'nope' }));
    await expect(c.me()).rejects.toThrow();
  });
});
