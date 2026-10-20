import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect } from '../client.js'
import { createSessionStore, hashSessionId, type NewSession, type SessionStore } from '../session-store.js'
import { migratedPool, noDatabase, sqlState } from './db.js'

const MINUTE = 60_000
const t0 = new Date('2026-10-19T08:00:00.000Z')
const at = (ms: number) => new Date(t0.getTime() + ms)

const newSession = (overrides: Partial<NewSession> = {}): NewSession => ({
  sessionId: randomBytes(32).toString('base64url'),
  subjectOid: randomUUID(),
  accountName: 'reader@contoso.example',
  roles: ['reader'],
  refreshToken: { ciphertext: randomBytes(48), iv: randomBytes(12), tag: randomBytes(16), keyId: 'k1' },
  idpSessionId: randomUUID(),
  createdAt: t0,
  idleExpiresAt: at(15 * MINUTE),
  absoluteExpiresAt: at(8 * 60 * MINUTE),
  ...overrides,
})

describe('hashSessionId', () => {
  it('is the SHA-256 digest of the session ID', () => {
    const digest = hashSessionId('abc')
    expect(digest).toHaveLength(32)
    expect(digest.toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe.skipIf(noDatabase)('session store (AD-5)', () => {
  let pool: pg.Pool
  let store: SessionStore

  beforeAll(async () => {
    pool = await migratedPool()
    store = createSessionStore(connect(pool))
  })
  afterAll(async () => {
    await pool?.end()
  })

  const storedRow = async (sessionId: string) =>
    (await pool.query('SELECT * FROM sessions WHERE id_hash = $1', [hashSessionId(sessionId)])).rows[0] as
      Record<string, unknown> | undefined

  it('stores only the SHA-256 of the session ID and the GCM-sealed refresh token', async () => {
    const input = newSession()
    await store.create(input)

    const row = await storedRow(input.sessionId)
    expect(row).toBeDefined()
    expect(row?.id_hash).toEqual(createHash('sha256').update(input.sessionId).digest())
    expect(row?.refresh_token_ciphertext).toEqual(input.refreshToken.ciphertext)
    expect(row?.refresh_token_iv).toEqual(input.refreshToken.iv)
    expect(row?.refresh_token_tag).toEqual(input.refreshToken.tag)
    const clear = Buffer.from(input.sessionId)
    for (const value of Object.values(row ?? {})) {
      expect(String(value)).not.toContain(input.sessionId)
      if (Buffer.isBuffer(value)) expect(value.includes(clear)).toBe(false)
    }
  })

  it('reads a live session back with its roles and sealed token', async () => {
    const input = newSession({ roles: ['reader', 'report_admin'] })
    await store.create(input)

    const session = await store.findLive(input.sessionId, at(MINUTE))
    expect(session).toEqual({
      subjectOid: input.subjectOid,
      accountName: input.accountName,
      roles: ['reader', 'report_admin'],
      refreshToken: input.refreshToken,
      idpSessionId: input.idpSessionId,
      createdAt: t0,
      lastSeenAt: t0,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
    })
  })

  it('does not find a session that was never created', async () => {
    expect(await store.findLive('no-such-session', t0)).toBeNull()
  })

  it('ends the session at the idle limit, not one millisecond before', async () => {
    const input = newSession()
    await store.create(input)

    expect(await store.findLive(input.sessionId, at(15 * MINUTE - 1))).not.toBeNull()
    expect(await store.findLive(input.sessionId, at(15 * MINUTE))).toBeNull()
  })

  it('ends the session at the absolute limit even while it stays active', async () => {
    const input = newSession()
    await store.create(input)

    /* Activity every 14 minutes keeps it idle-alive; the idle deadline is capped at the absolute one. */
    for (let minute = 14; minute < 8 * 60; minute += 14) {
      expect(await store.touch(input.sessionId, at(minute * MINUTE), at((minute + 15) * MINUTE))).toBe(true)
    }
    expect((await storedRow(input.sessionId))?.idle_expires_at).toEqual(input.absoluteExpiresAt)
    expect(await store.findLive(input.sessionId, at(8 * 60 * MINUTE - 1))).not.toBeNull()
    expect(await store.findLive(input.sessionId, at(8 * 60 * MINUTE))).toBeNull()
    expect(await store.touch(input.sessionId, at(8 * 60 * MINUTE), at(8 * 60 * MINUTE + 15 * MINUTE))).toBe(false)
  })

  it('records activity and slides the idle deadline', async () => {
    const input = newSession()
    await store.create(input)

    expect(await store.touch(input.sessionId, at(10 * MINUTE), at(25 * MINUTE))).toBe(true)
    const session = await store.findLive(input.sessionId, at(24 * MINUTE))
    expect(session?.lastSeenAt).toEqual(at(10 * MINUTE))
    expect(session?.idleExpiresAt).toEqual(at(25 * MINUTE))
  })

  it('refuses to revive an idle-expired session', async () => {
    const input = newSession()
    await store.create(input)

    expect(await store.touch(input.sessionId, at(15 * MINUTE), at(30 * MINUTE))).toBe(false)
    expect(await store.findLive(input.sessionId, at(15 * MINUTE))).toBeNull()
  })

  it('rotates the session ID at login, removing the one it replaces', async () => {
    const before = newSession()
    await store.create(before)
    const after = newSession({ subjectOid: before.subjectOid })
    await store.create(after, { replacing: before.sessionId })

    expect(await storedRow(before.sessionId)).toBeUndefined()
    expect(await store.findLive(after.sessionId, at(MINUTE))).not.toBeNull()
  })

  it('ends a session on sign-out and hands back the IdP session to end at Keycloak', async () => {
    const input = newSession()
    await store.create(input)

    expect(await store.end(input.sessionId)).toEqual({ idpSessionId: input.idpSessionId })
    expect(await store.findLive(input.sessionId, at(MINUTE))).toBeNull()
    expect(await store.end(input.sessionId)).toBeNull()
  })

  it('purges every session past its idle or absolute limit and keeps the live ones', async () => {
    const purgeAt = new Date('2030-01-01T12:00:00.000Z')
    const idleGone = newSession({ createdAt: at(0), idleExpiresAt: purgeAt, absoluteExpiresAt: at(1e12) })
    const absoluteGone = newSession({ createdAt: at(0), idleExpiresAt: purgeAt, absoluteExpiresAt: purgeAt })
    const live = newSession({
      createdAt: at(0),
      idleExpiresAt: new Date(purgeAt.getTime() + 1),
      absoluteExpiresAt: at(1e12),
    })
    for (const s of [idleGone, absoluteGone, live]) await store.create(s)

    expect(await store.purgeExpired(purgeAt)).toBeGreaterThanOrEqual(2)
    expect(await storedRow(idleGone.sessionId)).toBeUndefined()
    expect(await storedRow(absoluteGone.sessionId)).toBeUndefined()
    expect(await storedRow(live.sessionId)).toBeDefined()
  })

  it('rejects a malformed GCM nonce or tag and an idle deadline past the absolute one', async () => {
    const sealed = newSession().refreshToken
    const badIv = newSession({ refreshToken: { ...sealed, iv: randomBytes(16) } })
    const badTag = newSession({ refreshToken: { ...sealed, tag: randomBytes(8) } })
    const badDeadline = newSession({ idleExpiresAt: at(9 * 60 * MINUTE) })
    for (const input of [badIv, badTag, badDeadline]) {
      expect(await sqlState(() => store.create(input))).toBe('23514')
    }
  })
})
