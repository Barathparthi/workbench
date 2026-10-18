import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

export interface WebSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly csrfHash: Buffer;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly user: {
    readonly username: string;
    readonly displayName: string;
    readonly email: string | null;
    readonly status: 'active' | 'disabled';
  };
}

/** Browser sessions (migrations/0003). Tokens are looked up by SHA-256; raw tokens never reach the database. */
export class WebSessionsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(row: {
    id: string;
    tokenHash: Buffer;
    csrfHash: Buffer;
    userId: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.db
      .insertInto('web_sessions')
      .values({
        id: row.id,
        token_hash: row.tokenHash,
        csrf_hash: row.csrfHash,
        user_id: row.userId,
        created_at: row.createdAt,
        last_seen_at: row.createdAt,
        expires_at: row.expiresAt,
      })
      .execute();
  }

  async findByTokenHash(tokenHash: Buffer): Promise<WebSessionRow | undefined> {
    const r = await this.db
      .selectFrom('web_sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select([
        's.id',
        's.user_id',
        's.csrf_hash',
        's.created_at',
        's.last_seen_at',
        's.expires_at',
        'u.username',
        'u.display_name',
        'u.email',
        'u.status',
      ])
      .where('s.token_hash', '=', tokenHash)
      .executeTakeFirst();
    if (r === undefined) return undefined;
    return {
      id: r.id,
      userId: r.user_id,
      csrfHash: r.csrf_hash,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      user: { username: r.username, displayName: r.display_name, email: r.email, status: r.status },
    };
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db.updateTable('web_sessions').set({ last_seen_at: at }).where('id', '=', id).execute();
  }

  /** Deletes one session; true when it existed (so a double logout is not audited twice). */
  async delete(id: string): Promise<boolean> {
    const r = await this.db.deleteFrom('web_sessions').where('id', '=', id).executeTakeFirst();
    return r.numDeletedRows > 0n;
  }

  async deleteForUser(userId: string): Promise<number> {
    const r = await this.db.deleteFrom('web_sessions').where('user_id', '=', userId).executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  /** Removes sessions past their absolute expiry or idle for longer than `idleMs`. */
  async purgeExpired(now: Date, idleMs: number): Promise<number> {
    const idleBefore = new Date(now.getTime() - idleMs);
    const r = await this.db
      .deleteFrom('web_sessions')
      .where((eb) => eb.or([eb('expires_at', '<=', now), eb('last_seen_at', '<=', idleBefore)]))
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }
}
