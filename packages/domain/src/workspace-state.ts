/**
 * Workspace lifecycle (01_ARCHITECTURE/02_SOLUTION_ARCHITECTURE.md §6.1).
 * Persisted transitions are compare-and-set in SQL; this table is the single source of legality.
 */
export const WorkspaceStates = [
  'CREATED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'FAILED',
  'DELETING',
  'DELETED',
] as const;

export type WorkspaceState = (typeof WorkspaceStates)[number];

const transitions: Readonly<Record<WorkspaceState, readonly WorkspaceState[]>> = {
  CREATED: ['STARTING', 'DELETING'],
  STARTING: ['RUNNING', 'FAILED', 'STOPPING'],
  RUNNING: ['STOPPING', 'FAILED'],
  STOPPING: ['STOPPED', 'FAILED'],
  STOPPED: ['STARTING', 'DELETING'],
  FAILED: ['STARTING', 'STOPPING', 'DELETING'],
  DELETING: ['DELETED'],
  DELETED: [],
};

export function canTransitionWorkspace(from: WorkspaceState, to: WorkspaceState): boolean {
  return transitions[from].includes(to);
}

export function nextWorkspaceStates(from: WorkspaceState): readonly WorkspaceState[] {
  return transitions[from];
}
