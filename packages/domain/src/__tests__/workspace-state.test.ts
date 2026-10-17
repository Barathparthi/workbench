import { describe, expect, it } from 'vitest';

import {
  WorkspaceStates,
  canTransitionWorkspace,
  nextWorkspaceStates,
  type WorkspaceState,
} from '../index.js';

// Written out independently of the implementation table (02_SOLUTION_ARCHITECTURE §6.1).
const legal: ReadonlyArray<readonly [WorkspaceState, WorkspaceState]> = [
  ['CREATED', 'STARTING'],
  ['CREATED', 'DELETING'],
  ['STARTING', 'RUNNING'],
  ['STARTING', 'FAILED'],
  ['STARTING', 'STOPPING'],
  ['RUNNING', 'STOPPING'],
  ['RUNNING', 'FAILED'],
  ['STOPPING', 'STOPPED'],
  ['STOPPING', 'FAILED'],
  ['STOPPED', 'STARTING'],
  ['STOPPED', 'DELETING'],
  ['FAILED', 'STARTING'],
  ['FAILED', 'STOPPING'],
  ['FAILED', 'DELETING'],
  ['DELETING', 'DELETED'],
];
const isLegal = (from: WorkspaceState, to: WorkspaceState) => legal.some(([f, t]) => f === from && t === to);

const allPairs = WorkspaceStates.flatMap((from) => WorkspaceStates.map((to) => [from, to] as const));

describe('workspace state machine', () => {
  it('covers exactly the eight documented states', () => {
    expect(WorkspaceStates).toEqual([
      'CREATED',
      'STARTING',
      'RUNNING',
      'STOPPING',
      'STOPPED',
      'FAILED',
      'DELETING',
      'DELETED',
    ]);
  });

  it.each(allPairs.filter(([f, t]) => isLegal(f, t)))('allows %s → %s', (from, to) => {
    expect(canTransitionWorkspace(from, to)).toBe(true);
  });

  it.each(allPairs.filter(([f, t]) => !isLegal(f, t)))('rejects %s → %s', (from, to) => {
    expect(canTransitionWorkspace(from, to)).toBe(false);
  });

  it('never allows a self-transition (idempotent start/stop is handled by the caller, not the table)', () => {
    for (const state of WorkspaceStates) {
      expect(canTransitionWorkspace(state, state)).toBe(false);
    }
  });

  it('treats DELETED as terminal', () => {
    expect(nextWorkspaceStates('DELETED')).toEqual([]);
  });

  it('can always reach DELETED from any non-deleted state', () => {
    const reachable = (from: WorkspaceState, seen = new Set<WorkspaceState>()): Set<WorkspaceState> => {
      seen.add(from);
      for (const next of nextWorkspaceStates(from)) if (!seen.has(next)) reachable(next, seen);
      return seen;
    };
    for (const state of WorkspaceStates) {
      expect(reachable(state).has('DELETED')).toBe(true);
    }
  });
});
