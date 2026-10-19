import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createSessionRepository, runMigrations, type NewSession, type SessionRepository } from './index.js'
import { createFreshDatabase, sha256Length, testDatabaseUrl, type FreshDatabase } from './test-support.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = new Date('2026-10-19T08:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

let seed = 0
const newSession = (overrides: Partial<NewSession> = {}): NewSession => {
  seed += 1
  return {
    idHash: sha256Length(seed),
    subject: `00000000-0000-0000-0000-${String(seed).padStart(12, '0')}`,
    accountName: `reader${seed}@contoso.example`,
    roles: ['reader'],
    refreshTokenCiphertext: Buffer.alloc(12 + 16 + 40, 7),
    idpSessionId: `kc-${seed}`,
    createdAt: T0,
    lastSeenAt: T0,
    idleExpiresAt: at(15 * MINUTE),
    absoluteExpiresAt: at(8 * HOUR),
    ...overrides,
  }
}

describe.skipIf(!testDatabaseUrl)('sessions table (AD-5, on real Postgres)', () => {
  let fresh: FreshDatabase
  let sessions: SessionRepository

  beforeAll(async () => {
    fresh = await createFreshDatabase(testDatabaseUrl as string)
    const db = createDb(fresh.pool)
    await runMigrations(db)
    sessions = createSessionRepository(db)
  })
  afterAll(async () => {
    await fresh?.drop()
  })

  it('stores a session and returns it while live', async () => {
    const s = newSession({ roles: ['reader', 'report_admin'] })
    await sessions.create(s)
    const found = await sessions.findLive(s.idHash, at(MINUTE))
    expect(found).toMatchObject({
      subject: s.subject,
      accountName: s.accountName,
      roles: ['reader', 'report_admin'],
      idpSessionId: s.idpSessionId,
      createdAt: T0,
      absoluteExpiresAt: at(8 * HOUR),
    })
    expect(found?.refreshTokenCiphertext.equals(s.refreshTokenCiphertext)).toBe(true)
  })

  it('stores a session with no roles so a denied account can be told it has no access (AC-5, AC-7)', async () => {
    const s = newSession({ roles: [] })
    await sessions.create(s)
    expect((await sessions.findLive(s.idHash, at(MINUTE)))?.roles).toEqual([])
  })

  it('returns nothing for an unknown session id hash', async () => {
    expect(await sessions.findLive(sha256Length(250), at(MINUTE))).toBeUndefined()
  })

  it('is live one millisecond before the idle limit and gone at it (AC-9, 15 min idle)', async () => {
    const s = newSession()
    await sessions.create(s)
    expect(await sessions.findLive(s.idHash, at(15 * MINUTE - 1))).toBeDefined()
    expect(await sessions.findLive(s.idHash, at(15 * MINUTE))).toBeUndefined()
  })

  it('is live one millisecond before the absolute limit and gone at it, however active (AC-9, 8 h)', async () => {
    const s = newSession()
    await sessions.create(s)
    let now = T0
    while (now.getTime() + 10 * MINUTE < at(8 * HOUR).getTime()) {
      now = new Date(now.getTime() + 10 * MINUTE)
      expect(await sessions.touch(s.idHash, now, new Date(now.getTime() + 15 * MINUTE))).toBeDefined()
    }
    expect(await sessions.findLive(s.idHash, at(8 * HOUR - 1))).toBeDefined()
    expect(await sessions.findLive(s.idHash, at(8 * HOUR))).toBeUndefined()
    expect(await sessions.findLive(s.idHash, at(8 * HOUR + MINUTE))).toBeUndefined()
  })

  it('touch extends the idle limit but never beyond the absolute limit', async () => {
    const s = newSession()
    await sessions.create(s)
    const now = at(8 * HOUR - 5 * MINUTE)
    await sessions.touch(s.idHash, at(10 * MINUTE), at(25 * MINUTE))
    expect((await sessions.findLive(s.idHash, at(20 * MINUTE)))?.idleExpiresAt).toEqual(at(25 * MINUTE))
    // walk to near the absolute limit, then ask for 15 more minutes
    for (let m = 20; m < 8 * 60 - 5; m += 10) await sessions.touch(s.idHash, at(m * MINUTE), at((m + 15) * MINUTE))
    const touched = await sessions.touch(s.idHash, now, new Date(now.getTime() + 15 * MINUTE))
    expect(touched?.lastSeenAt).toEqual(now)
    expect(touched?.idleExpiresAt).toEqual(at(8 * HOUR))
  })

  it('touch does not revive a session that has already idled out', async () => {
    const s = newSession()
    await sessions.create(s)
    expect(await sessions.touch(s.idHash, at(15 * MINUTE), at(30 * MINUTE))).toBeUndefined()
    expect(await sessions.findLive(s.idHash, at(16 * MINUTE))).toBeUndefined()
  })

  it('sign-out ends the session so the old cookie no longer finds it (AC-9)', async () => {
    const s = newSession()
    await sessions.create(s)
    expect(await sessions.end(s.idHash, at(MINUTE))).toBe(true)
    expect(await sessions.findLive(s.idHash, at(2 * MINUTE))).toBeUndefined()
    expect(await sessions.touch(s.idHash, at(2 * MINUTE), at(17 * MINUTE))).toBeUndefined()
    expect(await sessions.end(s.idHash, at(3 * MINUTE))).toBe(false)
  })

  it('rotation at login ends the previous session and creates the new one atomically', async () => {
    const previous = newSession()
    await sessions.create(previous)
    const next = newSession({
      createdAt: at(MINUTE),
      lastSeenAt: at(MINUTE),
      idleExpiresAt: at(16 * MINUTE),
      absoluteExpiresAt: at(8 * HOUR + MINUTE),
    })
    await sessions.rotate(previous.idHash, next)
    expect(await sessions.findLive(previous.idHash, at(2 * MINUTE))).toBeUndefined()
    expect(await sessions.findLive(next.idHash, at(2 * MINUTE))).toBeDefined()
  })

  it('a failed rotation leaves the previous session untouched', async () => {
    const previous = newSession()
    await sessions.create(previous)
    const clash = newSession({ idHash: previous.idHash })
    await expect(sessions.rotate(previous.idHash, clash)).rejects.toThrow()
    expect(await sessions.findLive(previous.idHash, at(MINUTE))).toBeDefined()
  })

  it('purges ended and expired sessions only', async () => {
    const live = newSession({
      createdAt: at(9 * HOUR),
      lastSeenAt: at(9 * HOUR),
      idleExpiresAt: at(9 * HOUR + 15 * MINUTE),
      absoluteExpiresAt: at(17 * HOUR),
    })
    const idled = newSession({
      createdAt: at(8 * HOUR),
      lastSeenAt: at(8 * HOUR),
      idleExpiresAt: at(8 * HOUR + 15 * MINUTE),
      absoluteExpiresAt: at(16 * HOUR),
    })
    const ended = newSession({
      createdAt: at(9 * HOUR),
      lastSeenAt: at(9 * HOUR),
      idleExpiresAt: at(9 * HOUR + 15 * MINUTE),
      absoluteExpiresAt: at(17 * HOUR),
    })
    await sessions.create(live)
    await sessions.create(idled)
    await sessions.create(ended)
    await sessions.end(ended.idHash, at(9 * HOUR + MINUTE))
    const now = at(9 * HOUR + 2 * MINUTE)
    const purged = await sessions.purgeExpired(now)
    expect(purged).toBeGreaterThanOrEqual(2)
    expect(await sessions.findLive(live.idHash, now)).toBeDefined()
    expect(await sessions.purgeExpired(now)).toBe(0)
    const remaining = await fresh.pool.query('SELECT id_hash FROM sessions')
    expect(remaining.rows.map((r: { id_hash: Buffer }) => r.id_hash.toString('hex'))).toEqual([
      live.idHash.toString('hex'),
    ])
  })

  describe('the table refuses rows that break AD-5', () => {
    const rejects = (s: NewSession, constraint: string) => expect(sessions.create(s)).rejects.toThrow(constraint)

    it('accepts a 32-byte SHA-256 id hash and rejects 31 or 33 bytes', async () => {
      await rejects(newSession({ idHash: Buffer.alloc(31, 201) }), 'sessions_id_hash_is_sha256')
      await rejects(newSession({ idHash: Buffer.alloc(33, 202) }), 'sessions_id_hash_is_sha256')
      await sessions.create(newSession({ idHash: Buffer.alloc(32, 203) }))
    })

    it('rejects a refresh token too short to be AES-256-GCM output (12-byte IV + 16-byte tag + data)', async () => {
      await rejects(newSession({ refreshTokenCiphertext: Buffer.alloc(28, 1) }), 'sessions_refresh_token_is_gcm')
      await sessions.create(newSession({ refreshTokenCiphertext: Buffer.alloc(29, 1) }))
    })

    it('rejects an absolute limit beyond 8 hours from creation, accepts exactly 8 hours', async () => {
      await rejects(newSession({ absoluteExpiresAt: at(8 * HOUR + 1) }), 'sessions_absolute_at_most_8h')
      await sessions.create(newSession({ absoluteExpiresAt: at(8 * HOUR) }))
    })

    it('rejects an idle limit beyond 15 minutes from last activity, accepts exactly 15 minutes', async () => {
      await rejects(newSession({ idleExpiresAt: at(15 * MINUTE + 1) }), 'sessions_idle_at_most_15m')
      await sessions.create(newSession({ idleExpiresAt: at(15 * MINUTE) }))
    })

    it('rejects an idle limit beyond the absolute limit', async () => {
      await rejects(
        newSession({
          lastSeenAt: at(8 * HOUR - MINUTE),
          idleExpiresAt: at(8 * HOUR + 1),
          absoluteExpiresAt: at(8 * HOUR),
        }),
        'sessions_idle_within_absolute',
      )
    })

    it('rejects a role outside reader and report_admin', async () => {
      await rejects(newSession({ roles: ['reader', 'owner'] as never }), 'sessions_roles_known')
    })
  })

  it('has no column that could hold a session id in clear or an access token (AC-8)', async () => {
    const { rows } = await fresh.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions' ORDER BY column_name`,
    )
    expect(rows.map((r) => r.column_name)).toEqual([
      'absolute_expires_at',
      'account_name',
      'created_at',
      'ended_at',
      'id_hash',
      'idle_expires_at',
      'idp_session_id',
      'last_seen_at',
      'refresh_token_ciphertext',
      'roles',
      'subject',
    ])
  })
})
