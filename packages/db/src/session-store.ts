import { createHash } from 'node:crypto'
import { and, eq, gt, lte, or, sql } from 'drizzle-orm'
import { guarded, type Database } from './client.js'
import { sessions } from './schema.js'

/* AES-256-GCM output as the BFF sealed it; this package never sees the key or the clear token. */
export interface SealedToken {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  keyId: string
}

export interface NewSession {
  sessionId: string
  subjectOid: string
  accountName: string
  roles: readonly string[]
  refreshToken: SealedToken
  idpSessionId: string | null
  createdAt: Date
  idleExpiresAt: Date
  absoluteExpiresAt: Date
}

export interface StoredSession {
  subjectOid: string
  accountName: string
  roles: string[]
  refreshToken: SealedToken
  idpSessionId: string | null
  createdAt: Date
  lastSeenAt: Date
  idleExpiresAt: Date
  absoluteExpiresAt: Date
}

export interface SessionStore {
  /* Inserts the session; with `replacing`, removes the pre-login session in the same transaction (rotation). */
  create(session: NewSession, options?: { replacing?: string }): Promise<void>
  /* The session when it is live at `now`: both deadlines are exclusive, so a session ends at its deadline. */
  findLive(sessionId: string, now: Date): Promise<StoredSession | null>
  /* Records activity and slides the idle deadline, never past the absolute one. False when no longer live. */
  touch(sessionId: string, now: Date, idleExpiresAt: Date): Promise<boolean>
  /* Ends the session, handing back the IdP session to end at Keycloak; null when there was none. */
  end(sessionId: string): Promise<{ idpSessionId: string | null } | null>
  /* Deletes every session past either deadline at `now`, returning how many went. */
  purgeExpired(now: Date): Promise<number>
}

export function hashSessionId(sessionId: string): Buffer {
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

const liveAt = (now: Date) => and(gt(sessions.idleExpiresAt, now), gt(sessions.absoluteExpiresAt, now))

export function createSessionStore(db: Database): SessionStore {
  return guarded({
    async create(session, options = {}) {
      const row = {
        idHash: hashSessionId(session.sessionId),
        subjectOid: session.subjectOid,
        accountName: session.accountName,
        roles: [...session.roles],
        refreshTokenCiphertext: session.refreshToken.ciphertext,
        refreshTokenIv: session.refreshToken.iv,
        refreshTokenTag: session.refreshToken.tag,
        refreshTokenKeyId: session.refreshToken.keyId,
        idpSessionId: session.idpSessionId,
        createdAt: session.createdAt,
        lastSeenAt: session.createdAt,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      }
      await db.transaction(async (tx) => {
        if (options.replacing !== undefined) {
          await tx.delete(sessions).where(eq(sessions.idHash, hashSessionId(options.replacing)))
        }
        await tx.insert(sessions).values(row)
      })
    },

    async findLive(sessionId, now) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.idHash, hashSessionId(sessionId)), liveAt(now)))
      if (!row) return null
      return {
        subjectOid: row.subjectOid,
        accountName: row.accountName,
        roles: row.roles,
        refreshToken: {
          ciphertext: row.refreshTokenCiphertext,
          iv: row.refreshTokenIv,
          tag: row.refreshTokenTag,
          keyId: row.refreshTokenKeyId,
        },
        idpSessionId: row.idpSessionId,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        idleExpiresAt: row.idleExpiresAt,
        absoluteExpiresAt: row.absoluteExpiresAt,
      }
    },

    async touch(sessionId, now, idleExpiresAt) {
      const updated = await db
        .update(sessions)
        .set({
          lastSeenAt: now,
          idleExpiresAt: sql`least(${idleExpiresAt.toISOString()}::timestamptz, ${sessions.absoluteExpiresAt})`,
        })
        .where(and(eq(sessions.idHash, hashSessionId(sessionId)), liveAt(now)))
        .returning({ idHash: sessions.idHash })
      return updated.length > 0
    },

    async end(sessionId) {
      const [ended] = await db
        .delete(sessions)
        .where(eq(sessions.idHash, hashSessionId(sessionId)))
        .returning({ idpSessionId: sessions.idpSessionId })
      return ended ?? null
    },

    async purgeExpired(now) {
      const purged = await db
        .delete(sessions)
        .where(or(lte(sessions.idleExpiresAt, now), lte(sessions.absoluteExpiresAt, now)))
        .returning({ idHash: sessions.idHash })
      return purged.length
    },
  })
}
