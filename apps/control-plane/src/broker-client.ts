import type { FsOp } from '@qe/contracts';
import { DomainError, isErrorCode } from '@qe/domain';

import type { BrokerFiles } from './remote-file-service.js';

/** Connect (10 s) plus one operation (15 s) plus transfer: the broker answers or times out on its own first. */
const FILES_TIMEOUT_MS = 40_000;
const CLOSE_TIMEOUT_MS = 5_000;

export interface BrokerClient {
  /** Revocation and policy changes: drop a live session (terminal or files) on the broker. */
  readonly close: (sessionId: string) => Promise<void>;
  readonly files: BrokerFiles;
}

/**
 * The broker's internal API with the shared service token (mTLS in Phase 16). One broker instance for now; routing
 * to the instance that owns a session comes with multiple replicas (Phase 16). Broker errors come back as their
 * API code; nothing from the response but the code is trusted.
 */
export function httpBroker(baseUrl: string | undefined, token: string | undefined): BrokerClient {
  const configured = baseUrl !== undefined && token !== undefined;
  const post = (path: string, body: unknown, timeoutMs: number) =>
    fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  return {
    close: async (sessionId) => {
      if (!configured) return;
      await post(`/internal/v1/sessions/${encodeURIComponent(sessionId)}/close`, {}, CLOSE_TIMEOUT_MS);
    },
    files: async (sessionId, op: FsOp, body) => {
      if (!configured) throw new DomainError('SSH_UNREACHABLE', 'no connection broker is configured');
      let res: Response;
      try {
        res = await post(
          `/internal/v1/sessions/${encodeURIComponent(sessionId)}/fs/${op}`,
          body,
          FILES_TIMEOUT_MS,
        );
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        throw new DomainError(
          timedOut ? 'SSH_TIMEOUT' : 'SSH_UNREACHABLE',
          timedOut ? 'the connection broker did not answer in time' : 'the connection broker is unavailable',
          { cause: error },
        );
      }
      const payload: unknown = await res.json().catch(() => undefined);
      if (res.ok) return payload;
      const code = (payload as { code?: unknown } | undefined)?.code;
      if (isErrorCode(code)) {
        const details = (payload as { details?: unknown }).details;
        throw new DomainError(code, 'the remote file operation failed', {
          ...(typeof details === 'object' &&
            details !== null && { details: details as Record<string, unknown> }),
        });
      }
      throw new DomainError('SSH_UNREACHABLE', 'the connection broker failed');
    },
  };
}
