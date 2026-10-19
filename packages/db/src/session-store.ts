/* AD-5 session storage. The caller (the API) owns the policy and passes the expiries it has
 * computed; the table's CHECKs refuse anything beyond 15 minutes idle or 8 hours in total.
 * The clear session ID never leaves this module: it is hashed before any query. */
import { createHash } from 'node:crypto'
import { and, eq, gt, lte, or, sql } from 'drizzle-orm'
import type { Db } from './db.js'
import type { Clock } from './clock.js'
import { session, type SessionRole } from './schema.js'

/** AES-256-GCM output, produced and opened by the API; stored as given. */
export interface EncryptedRefreshToken {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

export interface NewSession {
  sessionId: string
  subject: string
  accountName: string
  roles: SessionRole[]
  refreshToken: EncryptedRefreshToken
  keycloakSessionId: string | null
  idleExpiresAt: Date
  absoluteExpiresAt: Date
}

export interface ActiveSession {
  subject: string
  accountName: string
  roles: SessionRole[]
  refreshToken: EncryptedRefreshToken
  keycloakSessionId: string | null
  createdAt: Date
  lastSeenAt: Date
  idleExpiresAt: Date
  absoluteExpiresAt: Date
}

export interface EndedSession {
  keycloakSessionId: string | null
  refreshToken: EncryptedRefreshToken
}

export function hashSessionId(sessionId: string): Buffer {
  if (sessionId.length === 0) throw new Error('session ID must not be empty')
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

const activeAt = (now: Date) => and(gt(session.idleExpiresAt, now), gt(session.absoluteExpiresAt, now))

/** Stores a new session; with replacesSessionId, the old one is deleted in the same transaction (rotation at login). */
export async function createSession(
  db: Db,
  clock: Clock,
  input: NewSession,
  options: { replacesSessionId?: string } = {},
): Promise<void> {
  const now = clock.now()
  const row = {
    idHash: hashSessionId(input.sessionId),
    subject: input.subject,
    accountName: input.accountName,
    roles: input.roles,
    refreshTokenCiphertext: input.refreshToken.ciphertext,
    refreshTokenIv: input.refreshToken.iv,
    refreshTokenTag: input.refreshToken.tag,
    keycloakSessionId: input.keycloakSessionId,
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: input.idleExpiresAt,
    absoluteExpiresAt: input.absoluteExpiresAt,
  }
  const { replacesSessionId } = options
  if (replacesSessionId === undefined) {
    await db.insert(session).values(row)
    return
  }
  await db.transaction(async (tx) => {
    await tx.delete(session).where(eq(session.idHash, hashSessionId(replacesSessionId)))
    await tx.insert(session).values(row)
  })
}

/** The session if it is still inside both limits at the clock's instant, else null. */
export async function findActiveSession(db: Db, clock: Clock, sessionId: string): Promise<ActiveSession | null> {
  const [row] = await db
    .select()
    .from(session)
    .where(and(eq(session.idHash, hashSessionId(sessionId)), activeAt(clock.now())))
  if (!row) return null
  return {
    subject: row.subject,
    accountName: row.accountName,
    roles: row.roles,
    refreshToken: { ciphertext: row.refreshTokenCiphertext, iv: row.refreshTokenIv, tag: row.refreshTokenTag },
    keycloakSessionId: row.keycloakSessionId,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
  }
}

/** Records activity and slides the idle expiry, never past the absolute one. False when the session has already ended. */
export async function touchSession(db: Db, clock: Clock, sessionId: string, idleExpiresAt: Date): Promise<boolean> {
  const now = clock.now()
  const result = await db
    .update(session)
    .set({
      lastSeenAt: now,
      idleExpiresAt: sql`least(${idleExpiresAt.toISOString()}::timestamptz, ${session.absoluteExpiresAt})`,
    })
    .where(and(eq(session.idHash, hashSessionId(sessionId)), activeAt(now)))
  return result.rowCount === 1
}

/** Deletes the session (sign-out) and returns what the API needs to end the Keycloak session too. */
export async function endSession(db: Db, sessionId: string): Promise<EndedSession | null> {
  const [row] = await db
    .delete(session)
    .where(eq(session.idHash, hashSessionId(sessionId)))
    .returning({
      keycloakSessionId: session.keycloakSessionId,
      ciphertext: session.refreshTokenCiphertext,
      iv: session.refreshTokenIv,
      tag: session.refreshTokenTag,
    })
  if (!row) return null
  return {
    keycloakSessionId: row.keycloakSessionId,
    refreshToken: { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
  }
}

/** Deletes every session at or past either limit; returns how many. */
export async function purgeExpiredSessions(db: Db, clock: Clock): Promise<number> {
  const now = clock.now()
  const result = await db
    .delete(session)
    .where(or(lte(session.idleExpiresAt, now), lte(session.absoluteExpiresAt, now)))
  return result.rowCount ?? 0
}
