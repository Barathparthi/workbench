import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type { Database } from '../db/schema.js';

export interface UserIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string | undefined;
}

export interface LoginUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly status: 'active' | 'disabled';
}

export class UsersRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /** Creates the user on first sight of an (issuer, subject); returns its id. */
  async upsertIdentity(identity: UserIdentity): Promise<string> {
    return (await this.upsertLogin(identity, false)).id;
  }

  /**
   * Creates or refreshes the user for an (issuer, subject). Display name and email follow the IdP; the
   * username does not change after creation (it maps SSH principals). A username taken by another
   * identity raises a unique violation, which the caller reports as a login failure.
   */
  async upsertLogin(identity: UserIdentity, login = true): Promise<LoginUser> {
    const now = new Date();
    const row = await this.db
      .insertInto('users')
      .values({
        id: uuidv7(),
        oidc_issuer: identity.issuer,
        oidc_subject: identity.subject,
        username: identity.username,
        email: identity.email ?? null,
        display_name: identity.displayName,
        status: 'active',
        last_login_at: login ? now : null,
      })
      .onConflict((oc) =>
        oc.columns(['oidc_issuer', 'oidc_subject']).doUpdateSet({
          display_name: identity.displayName,
          email: identity.email ?? null,
          updated_at: now,
          ...(login && { last_login_at: now }),
        }),
      )
      .returning(['id', 'username', 'display_name', 'email', 'status'])
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      status: row.status,
    };
  }

  async findById(id: string) {
    return this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async setStatus(id: string, status: 'active' | 'disabled'): Promise<void> {
    await this.db.updateTable('users').set({ status, updated_at: new Date() }).where('id', '=', id).execute();
  }

  /**
   * Replaces the roles that came from IdP groups with `roles`; manually granted roles stay. Role rows are
   * created on first use (lab roles). Run inside a transaction.
   */
  async replaceIdpRoles(userId: string, roles: readonly string[]): Promise<void> {
    await this.db
      .deleteFrom('user_roles')
      .where('user_id', '=', userId)
      .where('source', '=', 'idp_group')
      .execute();
    if (roles.length === 0) return;
    await this.db
      .insertInto('roles')
      .values(roles.map((name) => ({ id: uuidv7(), name })))
      .onConflict((oc) => oc.column('name').doNothing())
      .execute();
    const ids = await this.db.selectFrom('roles').select('id').where('name', 'in', roles).execute();
    await this.db
      .insertInto('user_roles')
      .values(ids.map((r) => ({ user_id: userId, role_id: r.id, source: 'idp_group' as const })))
      .onConflict((oc) => oc.columns(['user_id', 'role_id']).doNothing())
      .execute();
  }

  /** All role names of a user (IdP and manual), sorted. */
  async rolesOf(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('user_roles')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .select('roles.name')
      .where('user_roles.user_id', '=', userId)
      .orderBy('roles.name')
      .execute();
    return rows.map((r) => r.name);
  }
}
