import { canTransitionWorkspace, DomainError, type WorkspaceState } from '@qe/domain';
import { sql, type Kysely, type Selectable } from 'kysely';

import type { Database, WorkspacesTable } from '../db/schema.js';

export type WorkspaceRow = Selectable<WorkspacesTable>;

export interface NewWorkspace {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly templateId: string;
  readonly runtimeKind: WorkspacesTable['runtime_kind'];
  readonly resourceProfile: string;
  readonly gitUrl: string | null;
  readonly gitRef: string | null;
}

/** Postgres unique_violation, e.g. a second workspace with the same name for one owner. */
export const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === '23505';

export class WorkspacesRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(w: NewWorkspace): Promise<WorkspaceRow> {
    return this.db
      .insertInto('workspaces')
      .values({
        id: w.id,
        name: w.name,
        owner_id: w.ownerId,
        template_id: w.templateId,
        state: 'CREATED',
        runtime_kind: w.runtimeKind,
        resource_profile: w.resourceProfile,
        git_url: w.gitUrl,
        git_ref: w.gitRef,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The workspace if `userId` is a member and it is not deleted; invisible otherwise (404, no enumeration). */
  async findVisible(
    id: string,
    userId: string,
  ): Promise<(WorkspaceRow & { member_role: string }) | undefined> {
    return this.db
      .selectFrom('workspaces')
      .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
      .selectAll('workspaces')
      .select('workspace_members.role as member_role')
      .where('workspaces.id', '=', id)
      .where('workspace_members.user_id', '=', userId)
      .where('workspaces.state', '<>', 'DELETED')
      .executeTakeFirst();
  }

  async listForUser(userId: string, limit: number): Promise<WorkspaceRow[]> {
    return this.db
      .selectFrom('workspaces')
      .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
      .selectAll('workspaces')
      .where('workspace_members.user_id', '=', userId)
      .where('workspaces.state', '<>', 'DELETED')
      .orderBy('workspaces.created_at', 'desc')
      .limit(limit)
      .execute();
  }

  async update(
    id: string,
    fields: { name?: string; gitUrl?: string | null; gitRef?: string | null },
  ): Promise<WorkspaceRow | undefined> {
    return this.db
      .updateTable('workspaces')
      .set({
        ...(fields.name !== undefined && { name: fields.name }),
        ...(fields.gitUrl !== undefined && { git_url: fields.gitUrl, git_ref: fields.gitRef ?? null }),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('state', '<>', 'DELETED')
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Compare-and-set state change (03 §3.5): succeeds only if the row is still in `from`. Returns null when
   * another writer won the race; the caller re-reads.
   */
  async transition(
    id: string,
    from: WorkspaceState,
    to: WorkspaceState,
    reason?: string,
  ): Promise<WorkspaceRow | null> {
    if (!canTransitionWorkspace(from, to)) throw new DomainError('CONFLICT', `illegal ${from} -> ${to}`);
    return (
      (await this.db
        .updateTable('workspaces')
        .set({
          state: to,
          state_reason: reason ?? null,
          state_version: sql`state_version + 1`,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .where('state', '=', from)
        .returningAll()
        .executeTakeFirst()) ?? null
    );
  }
}
