import { RedeemTicketResponse } from '@qe/contracts';
import { DomainError } from '@qe/broker-core';

/** What the broker reports about a session (control plane: `POST /internal/v1/sessions/{id}/state`). */
export interface StateReport {
  readonly state: 'ACTIVE' | 'CLOSED' | 'FAILED';
  readonly reason: string;
  readonly brokerInstance: string;
  readonly hostKey?: { outcome: string; algorithm: string; fingerprintSha256: string } | undefined;
  readonly bytesIn?: number;
  readonly bytesOut?: number;
}

export interface ControlPlaneClient {
  /** Redeems a ticket once; rejects with AUTH_REQUIRED (or the control plane's code) when it is not valid. */
  redeem(ticket: string, origin: string): Promise<RedeemTicketResponse>;
  /** Best effort: a lost report is repaired by the control plane's session sweep. */
  report(sessionId: string, report: StateReport): Promise<void>;
  /** At startup: this instance holds no sessions, so the control plane closes the ones recorded on it. */
  started(brokerInstance: string): Promise<{ closed: number }>;
}

const TIMEOUT_MS = 5_000;

export function httpControlPlane(baseUrl: string, token: string): ControlPlaneClient {
  const post = (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  return {
    async redeem(ticket, origin) {
      const res = await post('/internal/v1/tickets:redeem', { ticket, origin });
      const body: unknown = await res.json().catch(() => undefined);
      if (!res.ok) {
        const code = (body as { code?: string } | undefined)?.code;
        throw new DomainError(
          code === 'TARGET_NOT_ALLOWED' ? 'TARGET_NOT_ALLOWED' : 'AUTH_REQUIRED',
          'ticket refused',
        );
      }
      return RedeemTicketResponse.parse(body);
    },
    async report(sessionId, report) {
      await post(`/internal/v1/sessions/${encodeURIComponent(sessionId)}/state`, report);
    },
    async started(brokerInstance) {
      const res = await post(`/internal/v1/brokers/${encodeURIComponent(brokerInstance)}/started`, {});
      if (!res.ok) throw new DomainError('INTERNAL_ERROR', `control plane answered ${String(res.status)}`);
      return (await res.json()) as { closed: number };
    },
  };
}
