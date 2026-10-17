/**
 * Remote session lifecycle (01_ARCHITECTURE/02_SOLUTION_ARCHITECTURE.md §6.2,
 * sessions.state CHECK constraint in 06_DATA_MODEL.md).
 *
 *   REQUESTED → AUTHORIZED → CONNECTING → ACTIVE → CLOSING → CLOSED
 *        └─► DENIED   └─► EXPIRED   └─► FAILED   └─► REVOKED → CLOSED
 */
export const SessionStates = [
  'REQUESTED',
  'AUTHORIZED',
  'DENIED',
  'CONNECTING',
  'ACTIVE',
  'CLOSING',
  'CLOSED',
  'FAILED',
  'EXPIRED',
  'REVOKED',
] as const;

export type SessionState = (typeof SessionStates)[number];

const transitions: Readonly<Record<SessionState, readonly SessionState[]>> = {
  REQUESTED: ['AUTHORIZED', 'DENIED'],
  AUTHORIZED: ['CONNECTING', 'EXPIRED'],
  CONNECTING: ['ACTIVE', 'FAILED'],
  ACTIVE: ['CLOSING', 'REVOKED'],
  CLOSING: ['CLOSED'],
  REVOKED: ['CLOSED'],
  CLOSED: [],
  DENIED: [],
  EXPIRED: [],
  FAILED: [],
};

export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return transitions[from].includes(to);
}

export function nextSessionStates(from: SessionState): readonly SessionState[] {
  return transitions[from];
}

export function isTerminalSessionState(state: SessionState): boolean {
  return transitions[state].length === 0;
}
