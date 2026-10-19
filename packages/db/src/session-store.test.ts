import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './database.js'
import { DB_ROLES } from './roles.js'
import {
  SESSION_ABSOLUTE_LIMIT_MS,
  SESSION_IDLE_LIMIT_MS,
  createSessionStore,
  type NewSession,
} from './session-store.js'
import { FixedClock, migratedOwnerPool, poolAs, testDatabaseUrl } from './test-database.js'
import { hashSecret, open, seal } from './token-seal.js'

const MINUTE = 60_000
const key = randomBytes(32)
const signIn = new Date('2026-10-19T08:00:00.000Z')

function newSession(overrides: Partial<NewSession> = {}): NewSession & { refreshPlain: string } {
  const sessionId = randomBytes(32).toString('base64url')
  const refreshPlain = `rt-${randomBytes(8).toString('hex')}`
  return {
    sessionId,
    subject: 'oid-reader-1',
    username: 'reader@contoso.example',
    roles: ['reader'],
    refreshToken: seal(key, refreshPlain, hashSecret(sessionId)),
    idpSessionId: `kc-${randomBytes(4).toString('hex')}`,
    refreshPlain,
    ...overrides,
  }
}

describe.skipIf(!testDatabaseUrl)('session store (AD-5) on PostgreSQL as sr_api', () => {
  const url = testDatabaseUrl as string
  let owner: pg.Pool
  let api: pg.Pool
  const clock = new FixedClock(signIn)

  beforeAll(async () => {
    owner = await migratedOwnerPool(url)
    api = poolAs(url, DB_ROLES.api)
  })
  afterAll(async () => {
    await api?.end()
    await owner?.end()
  })

  const store = () => createSessionStore(createDatabase(api), clock)

  it('stores only the SHA-256 of the session ID and the GCM ciphertext of the refresh token', async () => {
    clock.set(signIn)
    const s = newSession()
    await store().create(s)
    const { rows } = await owner.query('select * from sessions where id_hash = $1', [hashSecret(s.sessionId)])
    expect(rows).toHaveLength(1)
    const stored = Object.values(rows[0] as Record<string, unknown>)
      .map((v) => (Buffer.isBuffer(v) ? v.toString('latin1') : String(v)))
      .join('|')
    expect(stored).not.toContain(s.sessionId)
    expect(stored).not.toContain(s.refreshPlain)
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'absolute_expires_at',
        'created_at',
        'id_hash',
        'idp_session_id',
        'last_seen_at',
        'refresh_token_ciphertext',
        'refresh_token_iv',
        'refresh_token_tag',
        'roles',
        'subject',
        'username',
      ].sort(),
    )
    expect((rows[0] as { id_hash: Buffer }).id_hash.equals(hashSecret(s.sessionId))).toBe(true)
  })

  it('resumes a live session with its roles, limits and an openable refresh token', async () => {
    clock.set(signIn)
    const s = newSession({ roles: ['reader', 'admin'] })
    await store().create(s)
    clock.advance(5 * MINUTE)
    const resumed = await store().resume(s.sessionId)
    expect(resumed).not.toBeNull()
    expect(resumed?.roles).toEqual(['reader', 'admin'])
    expect(resumed?.username).toBe('reader@contoso.example')
    expect(resumed?.lastSeenAt.toISOString()).toBe('2026-10-19T08:05:00.000Z')
    expect(resumed?.idleExpiresAt.toISOString()).toBe('2026-10-19T08:20:00.000Z')
    expect(resumed?.absoluteExpiresAt.toISOString()).toBe('2026-10-19T16:00:00.000Z')
    expect(open(key, resumed!.refreshToken, hashSecret(s.sessionId))).toBe(s.refreshPlain)
  })

  it('keeps a session holding no app role, so a denied account can be named and signed out', async () => {
    clock.set(signIn)
    const s = newSession({ roles: [] })
    await store().create(s)
    expect((await store().resume(s.sessionId))?.roles).toEqual([])
  })

  it('returns null for an unknown session ID', async () => {
    expect(await store().resume('never-issued')).toBeNull()
  })

  it('ends after 15 minutes idle: alive 1 ms before, gone at the limit', async () => {
    clock.set(signIn)
    const a = newSession()
    const b = newSession()
    await store().create(a)
    await store().create(b)
    clock.set(new Date(signIn.getTime() + SESSION_IDLE_LIMIT_MS - 1))
    expect(await store().resume(a.sessionId)).not.toBeNull()
    clock.set(new Date(signIn.getTime() + SESSION_IDLE_LIMIT_MS))
    expect(await store().resume(b.sessionId)).toBeNull()
  })

  it('activity slides the idle limit', async () => {
    clock.set(signIn)
    const s = newSession()
    await store().create(s)
    clock.advance(13 * MINUTE)
    expect(await store().resume(s.sessionId)).not.toBeNull()
    clock.advance(13 * MINUTE)
    expect(await store().resume(s.sessionId)).not.toBeNull()
  })

  it('ends after 8 hours in total even when active: alive 1 ms before, gone at 16:00 and at 16:01', async () => {
    clock.set(signIn)
    const s = newSession()
    await store().create(s)
    for (let t = 10; t < 8 * 60; t += 10) {
      clock.set(new Date(signIn.getTime() + t * MINUTE))
      expect(await store().resume(s.sessionId)).not.toBeNull()
    }
    clock.set(new Date(signIn.getTime() + SESSION_ABSOLUTE_LIMIT_MS - 1))
    expect(await store().resume(s.sessionId)).not.toBeNull()
    clock.set(new Date(signIn.getTime() + SESSION_ABSOLUTE_LIMIT_MS))
    expect(await store().resume(s.sessionId)).toBeNull()
    clock.set(new Date('2026-10-19T16:01:00.000Z'))
    expect(await store().resume(s.sessionId)).toBeNull()
  })

  it('an expired session is not revived by a later resume', async () => {
    clock.set(signIn)
    const s = newSession()
    await store().create(s)
    clock.advance(SESSION_IDLE_LIMIT_MS)
    expect(await store().resume(s.sessionId)).toBeNull()
    clock.advance(-1)
    expect(await store().resume(s.sessionId)).toBeNull()
  })

  it('sign-out ends the session, returns the Keycloak session to end, and the old cookie no longer resumes', async () => {
    clock.set(signIn)
    const s = newSession()
    await store().create(s)
    expect(await store().end(s.sessionId)).toEqual({ idpSessionId: s.idpSessionId })
    expect(await store().resume(s.sessionId)).toBeNull()
    expect(await store().end(s.sessionId)).toBeNull()
  })

  it('rotates at login: the replaced session ID stops working', async () => {
    clock.set(signIn)
    const before = newSession({ roles: [] })
    await store().create(before)
    const after = newSession()
    await store().create(after, { replaces: before.sessionId })
    expect(await store().resume(before.sessionId)).toBeNull()
    expect(await store().resume(after.sessionId)).not.toBeNull()
  })

  it('purges idle- and absolute-expired sessions and keeps live ones', async () => {
    const t0 = new Date('2026-10-20T08:00:00.000Z')
    clock.set(t0)
    const absolute = newSession()
    await store().create(absolute)
    clock.set(new Date(t0.getTime() + 7 * 60 * MINUTE + 50 * MINUTE))
    const idle = newSession()
    await store().create(idle)
    await store().resume(absolute.sessionId)
    clock.set(new Date(t0.getTime() + SESSION_ABSOLUTE_LIMIT_MS))
    const live = newSession()
    await store().create(live)
    clock.set(new Date(t0.getTime() + 7 * 60 * MINUTE + 50 * MINUTE + SESSION_IDLE_LIMIT_MS))
    expect(await store().purgeExpired()).toBeGreaterThanOrEqual(2)
    const ids = (await owner.query<{ id_hash: Buffer }>('select id_hash from sessions')).rows.map((r) =>
      r.id_hash.toString('hex'),
    )
    expect(ids).not.toContain(hashSecret(absolute.sessionId).toString('hex'))
    expect(ids).not.toContain(hashSecret(idle.sessionId).toString('hex'))
    expect(ids).toContain(hashSecret(live.sessionId).toString('hex'))
  })

  it('refuses a role outside reader and admin', async () => {
    clock.set(signIn)
    await expect(store().create(newSession({ roles: ['owner' as 'reader'] }))).rejects.toThrow()
  })

  it('a refused write surfaces no username, ciphertext or other bound parameter', async () => {
    clock.set(signIn)
    const s = newSession({ username: 'leaky.person@contoso.example', roles: ['owner' as 'reader'] })
    const error: unknown = await store()
      .create(s)
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(Error)
    const record = error as Error & Record<string, unknown>
    expect(record['constraint']).toBe('sessions_roles_known')
    const ciphertextHex = s.refreshToken.ciphertext.toString('hex')
    const ownProperties = Object.fromEntries(Object.getOwnPropertyNames(record).map((name) => [name, record[name]]))
    for (const surface of [record.message, JSON.stringify(ownProperties), String(record['detail'])]) {
      expect(surface).not.toContain('leaky.person')
      expect(surface).not.toContain(ciphertextHex)
    }
  })

  it('refuses a session ID hash or GCM parts of the wrong length', async () => {
    const insert = (idHash: Buffer, iv: Buffer, tag: Buffer) =>
      owner.query(
        `insert into sessions (id_hash, subject, username, roles, refresh_token_ciphertext, refresh_token_iv,
           refresh_token_tag, idp_session_id, created_at, last_seen_at, absolute_expires_at)
         values ($1, 's', 'u', '{}', '\\x00', $2, $3, 'kc', $4, $4, $4::timestamptz + interval '8 hours')`,
        [idHash, iv, tag, signIn],
      )
    await expect(insert(randomBytes(31), randomBytes(12), randomBytes(16))).rejects.toThrow(/check/)
    await expect(insert(randomBytes(32), randomBytes(11), randomBytes(16))).rejects.toThrow(/check/)
    await expect(insert(randomBytes(32), randomBytes(12), randomBytes(15))).rejects.toThrow(/check/)
  })

  it('refuses an absolute limit beyond 8 hours from creation', async () => {
    await expect(
      owner.query(
        `insert into sessions (id_hash, subject, username, roles, refresh_token_ciphertext, refresh_token_iv,
           refresh_token_tag, idp_session_id, created_at, last_seen_at, absolute_expires_at)
         values ($1, 's', 'u', '{}', '\\x00', $2, $3, 'kc', $4, $4, $4::timestamptz + interval '8 hours 1 millisecond')`,
        [randomBytes(32), randomBytes(12), randomBytes(16), signIn],
      ),
    ).rejects.toThrow(/check/)
  })

  it('sr_api cannot rewrite who a session belongs to, its roles or its limits', async () => {
    for (const column of [
      'roles',
      'subject',
      'absolute_expires_at',
      'created_at',
      'id_hash',
      'username',
      'refresh_token_ciphertext',
      'refresh_token_iv',
      'refresh_token_tag',
      'idp_session_id',
    ]) {
      await expect(api.query(`update sessions set ${column} = ${column}`)).rejects.toThrow(/permission denied/)
    }
  })
})
