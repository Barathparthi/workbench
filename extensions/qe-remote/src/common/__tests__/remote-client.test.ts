import { describe, expect, it, vi } from 'vitest';

import { cookieValue, describeFailure, remoteClient, RemoteApiError, streamTarget } from '../remote-client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('remote client', () => {
  it('lists targets same-origin with the session cookie', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(json(200, { items: [{ id: 't1', name: 'lab' }] })),
    );
    const client = remoteClient({ origin: 'https://qe.example', cookies: () => '', fetch: fetchMock });
    expect(await client.listTargets()).toEqual([{ id: 't1', name: 'lab' }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://qe.example/api/v1/targets');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include');
  });

  it('opens a terminal session with the CSRF token and a clamped size', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(json(201, { sessionId: 's', streamUrl: '/api/v1/sessions/s/stream', ticket: 'x' })),
    );
    const client = remoteClient({
      origin: 'https://qe.example',
      cookies: () => 'a=1; qews_csrf=tok',
      fetch: fetchMock,
    });
    await client.openTerminalSession('t/1', { cols: 5000, rows: 0 });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://qe.example/api/v1/targets/t%2F1/sessions');
    expect((init?.headers as Record<string, string>)['x-csrf-token']).toBe('tok');
    expect(JSON.parse(init?.body as string)).toEqual({ kind: 'terminal', terminal: { cols: 1000, rows: 1 } });
  });

  it('turns problem responses into coded errors with friendly messages', async () => {
    const client = remoteClient({
      origin: 'https://qe.example',
      cookies: () => '',
      fetch: () => Promise.resolve(json(429, { code: 'QUOTA_EXCEEDED' })),
    });
    const error = await client.openTerminalSession('t', { cols: 80, rows: 24 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteApiError);
    expect(describeFailure(error)).toContain('too many open remote sessions');
    expect(describeFailure(new RemoteApiError(404, 'NOT_FOUND'))).toContain('not allowed');
    expect(describeFailure(new RemoteApiError(401, 'AUTH_REQUIRED'))).toContain('sign-in has expired');
    expect(describeFailure(new RemoteApiError(429, 'RATE_LIMITED'))).toContain('Too many');
    expect(describeFailure(new Error('x'))).toBe('The remote connection could not be opened.');
  });

  it('reports non-JSON failures by status', async () => {
    const client = remoteClient({
      origin: 'https://qe.example',
      cookies: () => '',
      fetch: () => Promise.resolve(new Response('no', { status: 502 })),
    });
    await expect(client.listTargets()).rejects.toMatchObject({ code: 'HTTP_502' });
  });

  it('builds the stream URL with the ticket as a subprotocol, never in the URL', () => {
    const t = streamTarget('https://qe.example', {
      sessionId: 's',
      streamUrl: '/api/v1/sessions/s/stream',
      ticket: 'T1',
    });
    expect(t).toEqual({
      url: 'wss://qe.example/api/v1/sessions/s/stream',
      protocols: ['qews.v1', 'ticket.T1'],
    });
    expect(t.url).not.toContain('T1');
    expect(streamTarget('http://localhost:8080', { sessionId: 's', streamUrl: '/x', ticket: 'T' }).url).toBe(
      'ws://localhost:8080/x',
    );
  });

  it('reads cookies', () => {
    expect(cookieValue('qews_csrf=a%3Db; x=1', 'qews_csrf')).toBe('a=b');
    expect(cookieValue('x=1', 'qews_csrf')).toBeUndefined();
  });
});
