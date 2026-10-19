/* AD-5 session persistence. The store hashes the cookie value itself so the clear session
 * ID never reaches SQL, and takes every instant from the caller, whose injected Clock and
 * domain rules decide the 15 minute idle and 8 hour absolute limits. */
import { createHash } from 'node:crypto'
import type { Queryable } from './queryable.js'

export const SESSION_ROLES = ['reader', 'report_admin'] as const
export type SessionRole = (typeof SESSION_ROLES)[number]

export const SESSION_END_REASONS = ['logout', 'idle', 'absolute', 'rotated'] as const
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]

/** AES-256-GCM parts of the refresh token, encrypted by the API before it reaches the store. */
export interface EncryptedRefreshToken {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

export interface NewSession {
  /** The __Host-sr_session cookie value; only its SHA-256 is stored. */
  sessionId: string
  subjectOid: string
  accountName: string
  roles: readonly SessionRole[]
  refreshToken: EncryptedRefreshToken
  idpSessionId: string
  createdAt: Date
  idleExpiresAt: Date
  absoluteExpiresAt: Date
}

export interface LiveSession {
  subjectOid: string
  accountName: string
  roles: SessionRole[]
  refreshToken: EncryptedRefreshToken
  idpSessionId: string
  createdAt: Date
  lastSeenAt: Date
  idleExpiresAt: Date
  absoluteExpiresAt: Date
}

interface SessionRow {
  subject_oid: string
  account_name: string
  roles: string[]
  refresh_token_ciphertext: Buffer
  refresh_token_iv: Buffer
  refresh_token_tag: Buffer
  idp_session_id: string
  created_at: Date
  last_seen_at: Date
  idle_expires_at: Date
  absolute_expires_at: Date
}

export function hashSessionId(sessionId: string): Buffer {
  if (sessionId.length === 0) throw new Error('session ID must not be empty')
  return createHash('sha256').update(sessionId, 'utf8').digest()
}

function assertRoles(roles: readonly string[]): SessionRole[] {
  for (const role of roles) {
    if (!(SESSION_ROLES as readonly string[]).includes(role)) throw new Error(`unknown session role ${role}`)
  }
  return [...roles] as SessionRole[]
}

function assertRefreshToken({ ciphertext, iv, tag }: EncryptedRefreshToken): void {
  if (ciphertext.length === 0) throw new Error('refresh token ciphertext must not be empty')
  if (iv.length !== 12) throw new Error('refresh token GCM IV must be 96 bits')
  if (tag.length !== 16) throw new Error('refresh token GCM tag must be 128 bits')
}

const CREATE = `
WITH rotated AS (
  UPDATE session SET ended_at = $9, end_reason = 'rotated'
  WHERE id_hash = $10 AND ended_at IS NULL
)
INSERT INTO session (
  id_hash, subject_oid, account_name, roles,
  refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, idp_session_id,
  created_at, last_seen_at, idle_expires_at, absolute_expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $11, $12)`

const FIND_LIVE = `
SELECT subject_oid, account_name, roles,
       refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, idp_session_id,
       created_at, last_seen_at, idle_expires_at, absolute_expires_at
FROM session
WHERE id_hash = $1 AND ended_at IS NULL AND idle_expires_at > $2 AND absolute_expires_at > $2`

const TOUCH = `
UPDATE session SET last_seen_at = $2, idle_expires_at = LEAST($3, absolute_expires_at)
WHERE id_hash = $1 AND ended_at IS NULL AND idle_expires_at > $2 AND absolute_expires_at > $2
  AND last_seen_at <= $2`

const END = `
UPDATE session SET ended_at = $2, end_reason = $3
WHERE id_hash = $1 AND ended_at IS NULL
RETURNING idp_session_id`

export function createSessionStore(db: Queryable) {
  return {
    /** Stores a new session; `replaces` names the cookie it rotates out at login, ended in the same statement. */
    async create(session: NewSession, options: { replaces?: string } = {}): Promise<void> {
      const roles = assertRoles(session.roles)
      assertRefreshToken(session.refreshToken)
      if (session.idleExpiresAt.getTime() > session.absoluteExpiresAt.getTime()) {
        throw new Error('idle expiry must not be later than the absolute expiry')
      }
      await db.query(CREATE, [
        hashSessionId(session.sessionId),
        session.subjectOid,
        session.accountName,
        roles,
        session.refreshToken.ciphertext,
        session.refreshToken.iv,
        session.refreshToken.tag,
        session.idpSessionId,
        session.createdAt,
        options.replaces === undefined ? null : hashSessionId(options.replaces),
        session.idleExpiresAt,
        session.absoluteExpiresAt,
      ])
    },

    /** The session behind a cookie if it is neither ended, idle-expired nor absolute-expired at `now`. */
    async findLive(sessionId: string, now: Date): Promise<LiveSession | null> {
      const { rows } = await db.query<SessionRow>(FIND_LIVE, [hashSessionId(sessionId), now])
      const row = rows[0]
      if (row === undefined) return null
      return {
        subjectOid: row.subject_oid,
        accountName: row.account_name,
        roles: assertRoles(row.roles),
        refreshToken: {
          ciphertext: row.refresh_token_ciphertext,
          iv: row.refresh_token_iv,
          tag: row.refresh_token_tag,
        },
        idpSessionId: row.idp_session_id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        idleExpiresAt: row.idle_expires_at,
        absoluteExpiresAt: row.absolute_expires_at,
      }
    },

    /** Records activity at `now`, sliding the idle expiry but never past the absolute one. False if no longer live. */
    async touch(sessionId: string, now: Date, idleExpiresAt: Date): Promise<boolean> {
      const { rowCount } = await db.query(TOUCH, [hashSessionId(sessionId), now, idleExpiresAt])
      return (rowCount ?? 0) > 0
    },

    /** Ends a session and returns the Keycloak session to log out of, or null if it had already ended. */
    async end(sessionId: string, now: Date, reason: SessionEndReason): Promise<string | null> {
      if (!(SESSION_END_REASONS as readonly string[]).includes(reason)) throw new Error(`unknown end reason ${reason}`)
      const { rows } = await db.query<{ idp_session_id: string }>(END, [hashSessionId(sessionId), now, reason])
      return rows[0]?.idp_session_id ?? null
    },
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>
