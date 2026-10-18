import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const VALID = /^[A-Za-z0-9-]{8,64}$/;

/** Accepts a well-formed incoming `x-request-id` (05_API_CONTRACTS §1), otherwise generates one. */
export function requestIdFor(req: Pick<IncomingMessage, 'headers'>): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && VALID.test(incoming) ? incoming : randomUUID();
}
