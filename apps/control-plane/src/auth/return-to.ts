/**
 * Where to send the browser after login (T21 open redirect). Only a same-origin relative path is kept:
 * it must start with a single "/", and contain no backslash, scheme-relative "//", or control characters.
 * Anything else becomes "/". The result is appended to PUBLIC_ORIGIN, never used as a full URL.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  // Resolve against a dummy origin: the path must not change the origin (e.g. "/\t/evil" tricks).
  const resolved = new URL(value, 'https://return-to.invalid');
  if (resolved.origin !== 'https://return-to.invalid') return '/';
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
