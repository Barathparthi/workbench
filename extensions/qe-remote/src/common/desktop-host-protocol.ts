/**
 * The desktop app's private channel between Electron's main process and the IDE backend (PHASE_10 §10.4). The backend
 * runs in a forked process without Electron's APIs; main owns the two things it needs: `safeStorage` (the OS keychain
 * or DPAPI) and opening the system browser. Main listens on a fresh named pipe / Unix socket and hands the backend its
 * address and a random token in one environment variable, which the backend removes from its environment at once (so
 * terminals and tasks it starts never inherit it). Every connection must present the token first; there is no other
 * caller. The renderer never sees this channel.
 *
 * Newline-delimited JSON, one request and one response per line.
 */
export const DESKTOP_HOST_ENV = 'QE_DESKTOP_HOST';

export interface DesktopHostAddress {
  readonly address: string;
  readonly token: string;
}

export type DesktopHostRequest =
  | { readonly id: number; readonly op: 'openExternal'; readonly url: string }
  | { readonly id: number; readonly op: 'secret.get'; readonly key: string }
  | { readonly id: number; readonly op: 'secret.set'; readonly key: string; readonly value: string }
  | { readonly id: number; readonly op: 'secret.delete'; readonly key: string };

/**
 * `unavailable`: the OS offers no real encryption (no keyring on Linux, for instance), so nothing is stored — a secret
 * is never written in plain text. `refused`: the request is invalid (a URL that is not http(s), an oversized value).
 */
export type DesktopHostError = 'unavailable' | 'refused' | 'failed';

export type DesktopHostResponse =
  | { readonly id: number; readonly ok: true; readonly value?: string | null }
  | { readonly id: number; readonly ok: false; readonly error: DesktopHostError };

/** First line of every connection. */
export interface DesktopHostHello {
  readonly token: string;
}

/** Bounds on what crosses the channel. */
export const DESKTOP_HOST_LIMITS = {
  maxLineBytes: 64 * 1024,
  maxKeyLength: 256,
  maxValueLength: 16 * 1024,
  maxUrlLength: 8 * 1024,
} as const;

/** A URL main may open in the system browser: http(s) only, no credentials, bounded. */
export function isOpenableUrl(raw: string): boolean {
  if (raw.length > DESKTOP_HOST_LIMITS.maxUrlLength) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
  );
}
