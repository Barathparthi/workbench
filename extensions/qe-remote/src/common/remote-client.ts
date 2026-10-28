import { QEWS_PROTOCOL, TICKET_PROTOCOL_PREFIX, type FsOp } from '@qe/contracts';

/**
 * Browser-side client for the remote-session API (05_API_CONTRACTS §2.3–2.4). The IDE runs on the control plane's
 * origin (hosted: `/w/{id}/` behind the same gateway), so every call is same-origin with the session cookie; the
 * CSRF token is echoed from its cookie. Nothing here holds credentials — a ticket is single-use and lives 60 s.
 */
export interface TargetSummary {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly os: string;
  readonly tags: readonly string[];
  readonly description: string | null;
}

export interface OpenedSession {
  readonly sessionId: string;
  readonly streamUrl: string;
  readonly ticket: string;
}

export class RemoteApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'RemoteApiError';
  }
}

export function cookieValue(cookies: string, name: string): string | undefined {
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export interface RemoteClientDeps {
  readonly origin: string;
  readonly cookies: () => string;
  readonly fetch: typeof fetch;
}

async function failure(res: Response): Promise<RemoteApiError> {
  const body = (await res.json().catch(() => undefined)) as { code?: string } | undefined;
  return new RemoteApiError(res.status, body?.code ?? `HTTP_${String(res.status)}`);
}

/** One of the signed-in user's remote sessions (`GET /api/v1/sessions`). */
export interface SessionSummary {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly targetId: string | null;
}

/** A file operation can open the session's SFTP connection first (10 s) and then move up to 10 MB. */
const FILE_OP_TIMEOUT_MS = 60_000;

export type RemoteClient = ReturnType<typeof remoteClient>;

export function remoteClient(deps: RemoteClientDeps) {
  /** A same-origin POST with the session cookie and the CSRF token echoed from its cookie. */
  const post = async (path: string, body: unknown, timeoutMs: number): Promise<unknown> => {
    const csrf = cookieValue(deps.cookies(), 'qews_csrf');
    const res = await deps.fetch(`${deps.origin}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(csrf !== undefined && { 'x-csrf-token': csrf }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw await failure(res);
    return res.json();
  };

  return {
    async listTargets(): Promise<TargetSummary[]> {
      const res = await deps.fetch(`${deps.origin}/api/v1/targets`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { items: TargetSummary[] };
      return body.items;
    },

    async openTerminalSession(
      targetId: string,
      size: { cols: number; rows: number },
    ): Promise<OpenedSession> {
      return (await post(
        `/api/v1/targets/${encodeURIComponent(targetId)}/sessions`,
        {
          kind: 'terminal',
          terminal: {
            cols: Math.min(1000, Math.max(1, size.cols)),
            rows: Math.min(500, Math.max(1, size.rows)),
          },
        },
        10_000,
      )) as OpenedSession;
    },

    /** The user's own sessions, newest first. */
    async listSessions(): Promise<SessionSummary[]> {
      const res = await deps.fetch(`${deps.origin}/api/v1/sessions`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw await failure(res);
      return ((await res.json()) as { items: SessionSummary[] }).items;
    },

    /** A files-session (no ticket use: file operations authenticate with the sign-in cookie and ownership). */
    async openFilesSession(targetId: string): Promise<{ sessionId: string }> {
      return (await post(
        `/api/v1/targets/${encodeURIComponent(targetId)}/sessions`,
        { kind: 'files' },
        10_000,
      )) as {
        sessionId: string;
      };
    },

    /** One operation of 05_API_CONTRACTS §2.4 on a files-session; failures are RemoteApiErrors with the API code. */
    fileOp(sessionId: string, op: FsOp, body: object): Promise<unknown> {
      return post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fs/${op}`, body, FILE_OP_TIMEOUT_MS);
    },
  };
}

/** WebSocket URL and subprotocols for a session: the ticket travels as a subprotocol, never in the URL. */
export function streamTarget(origin: string, session: OpenedSession): { url: string; protocols: string[] } {
  const url = new URL(session.streamUrl, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return { url: url.href, protocols: [QEWS_PROTOCOL, `${TICKET_PROTOCOL_PREFIX}${session.ticket}`] };
}

/** What the user reads for a refused or failed connect (never internal detail). */
export function describeFailure(error: unknown): string {
  const code = error instanceof RemoteApiError ? error.code : undefined;
  switch (code) {
    case 'NOT_FOUND':
    case 'TARGET_NOT_ALLOWED':
    case 'FORBIDDEN':
      return 'You are not allowed to connect to this system.';
    case 'QUOTA_EXCEEDED':
      return 'You have too many open remote sessions. Close one first.';
    case 'AUTH_REQUIRED':
      return 'Your sign-in has expired. Reload the page to sign in again.';
    case 'SIGN_IN_REQUIRED':
      return 'Sign in to QE Workspace first: run “QE: Sign In to QE Workspace”.';
    case 'RATE_LIMITED':
      return 'Too many connection attempts. Wait a minute and try again.';
    default:
      return 'The remote connection could not be opened.';
  }
}
