import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

export class TemplatesRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async listEnabled() {
    return this.db
      .selectFrom('workspace_templates')
      .selectAll()
      .where('enabled', '=', true)
      .orderBy('id')
      .execute();
  }

  async findEnabled(id: string) {
    return this.db
      .selectFrom('workspace_templates')
      .selectAll()
      .where('id', '=', id)
      .where('enabled', '=', true)
      .executeTakeFirst();
  }
}
