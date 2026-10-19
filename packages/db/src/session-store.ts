/* AD-5 server-side sessions: the browser holds only the opaque session ID in the
 * __Host-sr_session cookie; this store keeps its SHA-256 and the sealed refresh token. */
import { and, eq, gt, lte, or, sql } from 'drizzle-orm'
import type { Clock } from './clock.js'
import { guarded, type Database } from './database.js'
import { sessions, type AppRole } from './schema.js'
import { hashSecret, type Sealed } from './token-seal.js'

export const SESSION_IDLE_LIMIT_MS = 15 * 60_000
export const SESSION_ABSOLUTE_LIMIT_MS = 8 * 60 * 60_000

export interface NewSession {
  sessionId: string
  subject: string
  username: string
  roles: readonly AppRole[]
  refreshToken: Sealed
  idpSessionId: string
}

export interface Session {
  subject: string
  username: string
  roles: AppRole[]
  refreshToken: Sealed
  idpSessionId: string
  createdAt: Date
  lastSeenAt: Date
  idleExpiresAt: Date
  absoluteExpiresAt: Date
}

const later = (instant: Date, ms: number) => new Date(instant.getTime() + ms)

function toSession(row: typeof sessions.$inferSelect): Session {
  return {
    subject: row.subject,
    username: row.username,
    roles: row.roles,
    refreshToken: { ciphertext: row.refreshTokenCiphertext, iv: row.refreshTokenIv, tag: row.refreshTokenTag },
    idpSessionId: row.idpSessionId,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    idleExpiresAt: later(row.lastSeenAt, SESSION_IDLE_LIMIT_MS),
    absoluteExpiresAt: row.absoluteExpiresAt,
  }
}

export function createSessionStore(db: Database, clock: Clock) {
  /* Live means: last seen less than the idle limit ago, and before the absolute limit. */
  const live = (now: Date) =>
    and(gt(sessions.lastSeenAt, later(now, -SESSION_IDLE_LIMIT_MS)), gt(sessions.absoluteExpiresAt, now))
  const expired = (now: Date) =>
    or(lte(sessions.lastSeenAt, later(now, -SESSION_IDLE_LIMIT_MS)), lte(sessions.absoluteExpiresAt, now))

  return guarded({
    /** Stores a new session; `replaces` ends the pre-login session in the same transaction (rotation). */
    async create(session: NewSession, options: { replaces?: string } = {}): Promise<Session> {
      const now = clock.now()
      return db.transaction(async (tx) => {
        if (options.replaces !== undefined) {
          await tx.delete(sessions).where(eq(sessions.idHash, hashSecret(options.replaces)))
        }
        const [row] = await tx
          .insert(sessions)
          .values({
            idHash: hashSecret(session.sessionId),
            subject: session.subject,
            username: session.username,
            roles: [...session.roles],
            refreshTokenCiphertext: session.refreshToken.ciphertext,
            refreshTokenIv: session.refreshToken.iv,
            refreshTokenTag: session.refreshToken.tag,
            idpSessionId: session.idpSessionId,
            createdAt: now,
            lastSeenAt: now,
            absoluteExpiresAt: later(now, SESSION_ABSOLUTE_LIMIT_MS),
          })
          .returning()
        return toSession(row!)
      })
    },

    /** Returns the live session and slides its idle limit, or null when unknown, idle or past 8 hours.
     * An expired session is deleted on sight, so nothing can bring it back. */
    async resume(sessionId: string): Promise<Session | null> {
      const now = clock.now()
      const idHash = hashSecret(sessionId)
      const [row] = await db
        .update(sessions)
        .set({ lastSeenAt: sql`greatest(${sessions.lastSeenAt}, ${now.toISOString()}::timestamptz)` })
        .where(and(eq(sessions.idHash, idHash), live(now)))
        .returning()
      if (row) return toSession(row)
      await db.delete(sessions).where(and(eq(sessions.idHash, idHash), expired(now)))
      return null
    },

    /** Signs out: removes the session so its cookie is useless, handing back the Keycloak session to end. */
    async end(sessionId: string): Promise<{ idpSessionId: string } | null> {
      const [row] = await db
        .delete(sessions)
        .where(eq(sessions.idHash, hashSecret(sessionId)))
        .returning({ idpSessionId: sessions.idpSessionId })
      return row ?? null
    },

    async purgeExpired(): Promise<number> {
      const now = clock.now()
      const purged = await db.delete(sessions).where(expired(now)).returning({ idHash: sessions.idHash })
      return purged.length
    },
  })
}

export type SessionStore = ReturnType<typeof createSessionStore>
