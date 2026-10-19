/* The BFF session store (AD-5). Callers pass the SHA-256 hash of the cookie value and the
 * AES-256-GCM ciphertext of the refresh token; the clear values never reach this module.
 * Time is always passed in (the caller's injected Clock), never read here. */
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { withoutQueryText, type Database } from './db.js'
import { sessions } from './schema.js'

export type StoredSession = typeof sessions.$inferSelect
export type NewSession = Omit<typeof sessions.$inferInsert, 'endedAt' | 'idpSessionId'> & {
  idpSessionId: string | null
}

export interface SessionRepository {
  create(session: NewSession): Promise<void>
  /** The session if it has not ended and `now` is before both its idle and absolute limits. */
  findLive(idHash: Buffer, now: Date): Promise<StoredSession | undefined>
  /** Records activity at `now` and moves the idle limit to `idleExpiresAt`, capped at the absolute limit. */
  touch(idHash: Buffer, now: Date, idleExpiresAt: Date): Promise<StoredSession | undefined>
  /** Ends a live session (sign-out); false when there was none. */
  end(idHash: Buffer, now: Date): Promise<boolean>
  /** Session-ID rotation at login: ends the previous session and creates the next in one transaction. */
  rotate(previousIdHash: Buffer, next: NewSession): Promise<void>
  /** Deletes ended and expired sessions; returns how many. */
  purgeExpired(now: Date): Promise<number>
}

const live = (idHash: Buffer, now: Date) =>
  and(
    eq(sessions.idHash, idHash),
    isNull(sessions.endedAt),
    gt(sessions.idleExpiresAt, now),
    gt(sessions.absoluteExpiresAt, now),
  )

export function createSessionRepository(db: Database): SessionRepository {
  return {
    async create(session) {
      await withoutQueryText(db.insert(sessions).values(session))
    },

    async findLive(idHash, now) {
      const [row] = await withoutQueryText(db.select().from(sessions).where(live(idHash, now)))
      return row
    },

    async touch(idHash, now, idleExpiresAt) {
      const [row] = await withoutQueryText(
        db
          .update(sessions)
          .set({
            lastSeenAt: now,
            idleExpiresAt: sql`least(${idleExpiresAt}::timestamptz, ${sessions.absoluteExpiresAt})`,
          })
          .where(live(idHash, now))
          .returning(),
      )
      return row
    },

    async end(idHash, now) {
      const ended = await withoutQueryText(
        db
          .update(sessions)
          .set({ endedAt: now })
          .where(and(eq(sessions.idHash, idHash), isNull(sessions.endedAt)))
          .returning({ idHash: sessions.idHash }),
      )
      return ended.length > 0
    },

    async rotate(previousIdHash, next) {
      await withoutQueryText(
        db.transaction(async (tx) => {
          await tx
            .update(sessions)
            .set({ endedAt: next.createdAt })
            .where(and(eq(sessions.idHash, previousIdHash), isNull(sessions.endedAt)))
          await tx.insert(sessions).values(next)
        }),
      )
    },

    async purgeExpired(now) {
      const { rows } = await db.execute<{ purged: number }>(
        sql`SELECT purge_expired_sessions(${now}::timestamptz) AS purged`,
      )
      return rows[0]?.purged ?? 0
    },
  }
}
