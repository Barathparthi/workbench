import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type { Database } from '../db/schema.js';

export interface UserIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
}

export class UsersRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /** Creates the user on first sight of an (issuer, subject); returns its id. */
  async upsertIdentity(identity: UserIdentity): Promise<string> {
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
      })
      .onConflict((oc) =>
        oc
          .columns(['oidc_issuer', 'oidc_subject'])
          .doUpdateSet({ display_name: identity.displayName, updated_at: new Date() }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async findById(id: string) {
    return this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
