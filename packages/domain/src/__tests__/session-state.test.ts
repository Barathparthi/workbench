import { describe, expect, it } from 'vitest';

import {
  SessionStates,
  canTransitionSession,
  isTerminalSessionState,
  nextSessionStates,
  type SessionState,
} from '../index.js';

// Written out independently of the implementation table (02_SOLUTION_ARCHITECTURE §6.2).
const legal: ReadonlyArray<readonly [SessionState, SessionState]> = [
  ['REQUESTED', 'AUTHORIZED'],
  ['REQUESTED', 'DENIED'],
  ['AUTHORIZED', 'CONNECTING'],
  ['AUTHORIZED', 'EXPIRED'],
  ['CONNECTING', 'ACTIVE'],
  ['CONNECTING', 'FAILED'],
  ['ACTIVE', 'CLOSING'],
  ['ACTIVE', 'REVOKED'],
  ['CLOSING', 'CLOSED'],
  ['REVOKED', 'CLOSED'],
];
const isLegal = (from: SessionState, to: SessionState) => legal.some(([f, t]) => f === from && t === to);

const allPairs = SessionStates.flatMap((from) => SessionStates.map((to) => [from, to] as const));

describe('remote session state machine', () => {
  it('matches the sessions.state CHECK constraint in 06_DATA_MODEL', () => {
    expect([...SessionStates].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it.each(allPairs.filter(([f, t]) => isLegal(f, t)))('allows %s → %s', (from, to) => {
    expect(canTransitionSession(from, to)).toBe(true);
  });

  it.each(allPairs.filter(([f, t]) => !isLegal(f, t)))('rejects %s → %s', (from, to) => {
    expect(canTransitionSession(from, to)).toBe(false);
  });

  it('has exactly CLOSED, DENIED, EXPIRED and FAILED as terminal states', () => {
    const terminal = SessionStates.filter((s) => isTerminalSessionState(s));
    expect([...terminal].sort()).toEqual(['CLOSED', 'DENIED', 'EXPIRED', 'FAILED']);
  });

  it('cannot skip authorization: REQUESTED never goes straight to CONNECTING or ACTIVE', () => {
    expect(nextSessionStates('REQUESTED')).not.toContain('CONNECTING');
    expect(nextSessionStates('REQUESTED')).not.toContain('ACTIVE');
  });

  it('cannot resurrect a revoked session', () => {
    expect(nextSessionStates('REVOKED')).toEqual(['CLOSED']);
  });
});
