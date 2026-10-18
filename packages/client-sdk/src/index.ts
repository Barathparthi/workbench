/**
 * @qe/client-sdk — Typed client for the control plane and broker, used by Theia extensions. Depends only on
 * @qe/contracts so frontend code never pulls in server-side packages.
 */
import { Me, ProblemDetails } from '@qe/contracts';

export const PACKAGE_NAME = '@qe/client-sdk';

export const CSRF_COOKIE = 'qews_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** A problem+json answer from the control plane. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | undefined,
  ) {
    super(problem?.title ?? `HTTP ${String(status)}`);
    this.name = 'ApiError';
  }
  get code(): string | undefined {
    return this.problem?.code;
  }
}

export interface ControlPlaneClientOptions {
  /** Origin of the control plane, e.g. `https://qe-workspace.corp` (same origin as the IDE when hosted). */
  readonly baseUrl: string;
  /** Returns the cookie header string (`document.cookie` in the browser). */
  readonly readCookies: () => string;
  /** Called on 401: navigate to the login page. Defaults to doing nothing (the error is still thrown). */
  readonly onUnauthenticated?: (loginUrl: string) => void;
  /** Where to return after login (relative path). */
  readonly currentPath?: () => string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Reads one cookie value from a `document.cookie`-style string. */
export function cookieValue(cookies: string, name: string): string | undefined {
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Control-plane client: sends the session cookie (credentials: include), echoes the CSRF token on unsafe
 * methods, maps problem+json errors to ApiError and turns 401 into a login redirect (Phase 04 §4.7).
 */
export class ControlPlaneClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ControlPlaneClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  loginUrl(): string {
    const returnTo = this.options.currentPath?.() ?? '/';
    return `${this.options.baseUrl}/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (!SAFE.has(method)) {
      const csrf = cookieValue(this.options.readCookies(), CSRF_COOKIE);
      if (csrf !== undefined) headers[CSRF_HEADER] = csrf;
    }
    const res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (res.status === 204) return undefined;
    const json: unknown = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
    if (!res.ok) {
      if (res.status === 401) this.options.onUnauthenticated?.(this.loginUrl());
      const problem = ProblemDetails.safeParse(json);
      throw new ApiError(res.status, problem.success ? problem.data : undefined);
    }
    return json;
  }

  async me(): Promise<Me> {
    return Me.parse(await this.request('GET', '/api/v1/me'));
  }

  async logout(): Promise<void> {
    await this.request('POST', '/auth/logout');
  }
}
