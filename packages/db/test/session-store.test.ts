/* ST-1 AC-7, AC-8, AC-9 at the storage boundary (AD-5): the session row holds only the
 * SHA-256 of the session ID and the AES-256-GCM ciphertext of the refresh token, a login
 * rotates the session, and the 15-minute idle and 8-hour absolute limits are proven with an
 * injected Clock at the limit and one millisecond below it. */
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  createSession,
  endSession,
  findActiveSession,
  purgeExpiredSessions,
  touchSession,
  type NewSession,
} from '../src/session-store.js'
import { session } from '../src/schema.js'
import { createTestDatabase, databaseUrl, fixedClock, sqlState, type TestDatabase } from './support/database.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const LOGIN = '2026-10-19T08:00:00.000Z'
const at = (offsetMs: number) => new Date(Date.parse(LOGIN) + offsetMs)

const newSession = (overrides: Partial<NewSession> = {}): NewSession => ({
  sessionId: randomBytes(32).toString('base64url'),
  subject: '6f1d2c3b-0000-4000-8000-00000000a001',
  accountName: 'reader@contoso.example',
  roles: ['reader'],
  refreshToken: { ciphertext: randomBytes(48), iv: randomBytes(12), tag: randomBytes(16) },
  keycloakSessionId: 'kc-session-1',
  idleExpiresAt: at(15 * MINUTE),
  absoluteExpiresAt: at(8 * HOUR),
  ...overrides,
})

describe.skipIf(!databaseUrl)('session store (AD-5)', () => {
  let t: TestDatabase
  const clock = fixedClock(LOGIN)

  beforeAll(async () => {
    t = await createTestDatabase()
  })
  afterAll(async () => {
    await t?.drop()
  })
  beforeEach(async () => {
    clock.set(LOGIN)
    await t.db.delete(session)
  })

  describe('what is stored', () => {
    it('stores only the SHA-256 of the session ID and the GCM ciphertext, never the clear values', async () => {
      const input = newSession()
      await createSession(t.db, clock, input)

      const { rows } = await t.pool.query('SELECT * FROM session')
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(Buffer.compare(row.id_hash, createHash('sha256').update(input.sessionId).digest())).toBe(0)
      expect(Buffer.compare(row.refresh_token_ciphertext, input.refreshToken.ciphertext)).toBe(0)
      expect(Buffer.compare(row.refresh_token_iv, input.refreshToken.iv)).toBe(0)
      expect(Buffer.compare(row.refresh_token_tag, input.refreshToken.tag)).toBe(0)
      expect(JSON.stringify(rows)).not.toContain(input.sessionId)
      expect(Object.keys(row).sort()).toEqual(
        [
          'absolute_expires_at',
          'account_name',
          'created_at',
          'id_hash',
          'idle_expires_at',
          'keycloak_session_id',
          'last_seen_at',
          'refresh_token_ciphertext',
          'refresh_token_iv',
          'refresh_token_tag',
          'roles',
          'subject',
        ].sort(),
      )
      expect(row.created_at.toISOString()).toBe(LOGIN)
      expect(row.last_seen_at.toISOString()).toBe(LOGIN)
    })

    it('rejects a session ID hash that is not 32 bytes', async () => {
      const state = await sqlState(
        t.pool.query(
          `INSERT INTO session (id_hash, subject, account_name, roles, refresh_token_ciphertext, refresh_token_iv,
             refresh_token_tag, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
           VALUES ($1, 's', 'a', '{reader}', $2, $3, $4, $5, $5, $6, $7)`,
          [randomBytes(31), randomBytes(16), randomBytes(12), randomBytes(16), at(0), at(MINUTE), at(HOUR)],
        ),
      )
      expect(state).toBe('23514')
    })

    it('rejects a GCM IV other than 12 bytes and a tag other than 16 bytes', async () => {
      const badIv = newSession({
        refreshToken: { ciphertext: randomBytes(8), iv: randomBytes(16), tag: randomBytes(16) },
      })
      expect(await sqlState(createSession(t.db, clock, badIv))).toBe('23514')
      const badTag = newSession({
        refreshToken: { ciphertext: randomBytes(8), iv: randomBytes(12), tag: randomBytes(12) },
      })
      expect(await sqlState(createSession(t.db, clock, badTag))).toBe('23514')
    })

    it('accepts only the reader and report_admin roles, and a session with no role (AC-5 denied account)', async () => {
      await createSession(t.db, clock, newSession({ roles: [] }))
      await createSession(t.db, clock, newSession({ roles: ['reader', 'report_admin'] }))
      const state = await sqlState(createSession(t.db, clock, newSession({ roles: ['reader', 'superuser'] as never })))
      expect(state).toBe('23514')
    })
  })

  describe('the 8-hour absolute limit', () => {
    it('accepts an absolute expiry exactly 8 hours after login', async () => {
      await createSession(t.db, clock, newSession({ absoluteExpiresAt: at(8 * HOUR) }))
    })

    it('rejects an absolute expiry one millisecond past 8 hours', async () => {
      const state = await sqlState(createSession(t.db, clock, newSession({ absoluteExpiresAt: at(8 * HOUR + 1) })))
      expect(state).toBe('23514')
    })

    it('finds the session one millisecond before the absolute limit and not at it, even when active', async () => {
      const input = newSession()
      await createSession(t.db, clock, input)
      for (let minutes = 10; minutes < 8 * 60; minutes += 10) {
        clock.set(at(minutes * MINUTE))
        expect(await touchSession(t.db, clock, input.sessionId, at(minutes * MINUTE + 15 * MINUTE))).toBe(true)
      }
      clock.set(at(8 * HOUR - 1))
      expect(await findActiveSession(t.db, clock, input.sessionId)).not.toBeNull()
      clock.set(at(8 * HOUR))
      expect(await findActiveSession(t.db, clock, input.sessionId)).toBeNull()
      expect(await touchSession(t.db, clock, input.sessionId, at(8 * HOUR + 15 * MINUTE))).toBe(false)
    })

    it('never lets a touch extend the idle expiry past the absolute limit', async () => {
      const input = newSession()
      await createSession(t.db, clock, input)
      for (let minutes = 10; minutes <= 7 * 60 + 50; minutes += 10) {
        clock.set(at(minutes * MINUTE))
        await touchSession(t.db, clock, input.sessionId, at(minutes * MINUTE + 15 * MINUTE))
      }
      const found = await findActiveSession(t.db, clock, input.sessionId)
      expect(found?.idleExpiresAt.toISOString()).toBe(at(8 * HOUR).toISOString())
    })
  })

  describe('the 15-minute idle limit', () => {
    it('accepts an idle expiry exactly 15 minutes after the last activity', async () => {
      await createSession(t.db, clock, newSession({ idleExpiresAt: at(15 * MINUTE) }))
    })

    it('rejects an idle expiry one millisecond past 15 minutes', async () => {
      const state = await sqlState(createSession(t.db, clock, newSession({ idleExpiresAt: at(15 * MINUTE + 1) })))
      expect(state).toBe('23514')
    })

    it('rejects an idle expiry later than the absolute expiry', async () => {
      const state = await sqlState(
        createSession(t.db, clock, newSession({ idleExpiresAt: at(15 * MINUTE), absoluteExpiresAt: at(10 * MINUTE) })),
      )
      expect(state).toBe('23514')
    })

    it('rejects an expiry that is not after the login instant', async () => {
      const state = await sqlState(createSession(t.db, clock, newSession({ idleExpiresAt: at(0) })))
      expect(state).toBe('23514')
    })

    it('finds the session one millisecond before the idle limit and not at it', async () => {
      const input = newSession()
      await createSession(t.db, clock, input)
      clock.set(at(15 * MINUTE - 1))
      const found = await findActiveSession(t.db, clock, input.sessionId)
      expect(found).toMatchObject({
        subject: input.subject,
        accountName: input.accountName,
        roles: ['reader'],
        keycloakSessionId: 'kc-session-1',
      })
      expect(found?.refreshToken.ciphertext.equals(input.refreshToken.ciphertext)).toBe(true)
      clock.set(at(15 * MINUTE))
      expect(await findActiveSession(t.db, clock, input.sessionId)).toBeNull()
    })

    it('a touch before the idle limit slides it; a touch at the limit does not revive the session', async () => {
      const input = newSession()
      await createSession(t.db, clock, input)
      clock.set(at(13 * MINUTE))
      expect(await touchSession(t.db, clock, input.sessionId, at(28 * MINUTE))).toBe(true)
      const touched = await findActiveSession(t.db, clock, input.sessionId)
      expect(touched?.lastSeenAt.toISOString()).toBe(at(13 * MINUTE).toISOString())
      expect(touched?.idleExpiresAt.toISOString()).toBe(at(28 * MINUTE).toISOString())

      clock.set(at(28 * MINUTE))
      expect(await touchSession(t.db, clock, input.sessionId, at(43 * MINUTE))).toBe(false)
      expect(await findActiveSession(t.db, clock, input.sessionId)).toBeNull()
    })

    it('does not find an unknown session ID', async () => {
      expect(await findActiveSession(t.db, clock, 'no-such-session')).toBeNull()
      expect(await touchSession(t.db, clock, 'no-such-session', at(15 * MINUTE))).toBe(false)
    })
  })

  describe('rotation and sign-out', () => {
    it('rotates at login: the replaced session ID stops working in the same step', async () => {
      const before = newSession()
      await createSession(t.db, clock, before)
      const after = newSession()
      await createSession(t.db, clock, after, { replacesSessionId: before.sessionId })
      expect(await findActiveSession(t.db, clock, before.sessionId)).toBeNull()
      expect(await findActiveSession(t.db, clock, after.sessionId)).not.toBeNull()
      const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM session')
      expect(rows[0].n).toBe(1)
    })

    it('keeps the replaced session when the new one is rejected', async () => {
      const before = newSession()
      await createSession(t.db, clock, before)
      const bad = newSession({ idleExpiresAt: at(HOUR) })
      expect(await sqlState(createSession(t.db, clock, bad, { replacesSessionId: before.sessionId }))).toBe('23514')
      expect(await findActiveSession(t.db, clock, before.sessionId)).not.toBeNull()
    })

    it('sign-out deletes the row and hands back what is needed to end the Keycloak session', async () => {
      const input = newSession()
      await createSession(t.db, clock, input)
      const ended = await endSession(t.db, input.sessionId)
      expect(ended?.keycloakSessionId).toBe('kc-session-1')
      expect(ended?.refreshToken.ciphertext.equals(input.refreshToken.ciphertext)).toBe(true)
      expect(await findActiveSession(t.db, clock, input.sessionId)).toBeNull()
      expect(await endSession(t.db, input.sessionId)).toBeNull()
    })
  })

  describe('purging expired sessions', () => {
    it('deletes sessions at or past either limit and keeps the ones one millisecond short of it', async () => {
      const idleEdge = newSession({ idleExpiresAt: at(10 * MINUTE) })
      const idleShort = newSession({ idleExpiresAt: at(10 * MINUTE + 1) })
      const absoluteEdge = newSession({ idleExpiresAt: at(10 * MINUTE), absoluteExpiresAt: at(10 * MINUTE) })
      for (const s of [idleEdge, idleShort, absoluteEdge]) await createSession(t.db, clock, s)

      clock.set(at(10 * MINUTE))
      expect(await purgeExpiredSessions(t.db, clock)).toBe(2)
      expect(await findActiveSession(t.db, clock, idleShort.sessionId)).not.toBeNull()
      const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM session')
      expect(rows[0].n).toBe(1)
    })
  })

  it('looks sessions up through the primary key on the hash', async () => {
    const { rows } = await t.db.execute<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'session' ORDER BY indexname`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE INDEX session_pkey .*\(id_hash\)/)
    expect(defs).toMatch(/session_idle_expires_at_idx/)
    expect(defs).toMatch(/session_absolute_expires_at_idx/)
  })
})
