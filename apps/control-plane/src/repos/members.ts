import type { Kysely } from 'kysely';

import type { Database, WorkspaceMembersTable } from '../db/schema.js';

export type MemberRole = WorkspaceMembersTable['role'];

export class MembersRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async add(workspaceId: string, userId: string, role: MemberRole): Promise<void> {
    await this.db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: userId, role })
      .execute();
  }

  async roleOf(workspaceId: string, userId: string): Promise<MemberRole | undefined> {
    const row = await this.db
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.role;
  }
}
