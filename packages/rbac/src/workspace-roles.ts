/** A user's role inside one workspace (06_DATA_MODEL `workspace_members.role`). */
export const WorkspaceRoles = ['viewer', 'editor', 'owner'] as const;
export type WorkspaceRole = (typeof WorkspaceRoles)[number];

const rank: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, owner: 2 };

export const isWorkspaceRole = (value: string): value is WorkspaceRole => Object.hasOwn(rank, value);

/** Whether `actual` is at least `required` (owner ⊇ editor ⊇ viewer). Unknown roles never qualify. */
export function hasWorkspaceRole(actual: string, required: WorkspaceRole): boolean {
  return isWorkspaceRole(actual) && rank[actual] >= rank[required];
}
