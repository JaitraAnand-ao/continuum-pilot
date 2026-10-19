import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSessionStore, hashSessionId, type NewSession } from '../src/index.js'
import { fakeDb } from './fake-db.js'

const sessionId = 'k3Jx9cY0pQ2mVw7tRb5nLz8aHf4sDg1e'
const createdAt = new Date('2026-10-19T08:00:00.000Z')

function newSession(overrides: Partial<NewSession> = {}): NewSession {
  return {
    sessionId,
    subjectOid: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    accountName: 'reader@contoso.example',
    roles: ['reader'],
    refreshToken: { ciphertext: Buffer.from('ciphertext'), iv: Buffer.alloc(12, 1), tag: Buffer.alloc(16, 2) },
    idpSessionId: 'kc-session-1',
    createdAt,
    idleExpiresAt: new Date('2026-10-19T08:15:00.000Z'),
    absoluteExpiresAt: new Date('2026-10-19T16:00:00.000Z'),
    ...overrides,
  }
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest()

describe('hashSessionId (AD-5: only the SHA-256 of the session ID is stored)', () => {
  it('is the SHA-256 digest of the cookie value', () => {
    expect(hashSessionId(sessionId).equals(sha256(sessionId))).toBe(true)
  })

  it('refuses an empty session ID', () => {
    expect(() => hashSessionId('')).toThrow(/session ID/)
  })
})

describe('session store create', () => {
  it('stores the hash and the GCM parts, never the clear session ID', async () => {
    const { db, queries } = fakeDb({ rows: [], rowCount: 1 })
    await createSessionStore(db).create(newSession())

    expect(queries).toHaveLength(1)
    const [query] = queries
    expect(query?.text).toMatch(/INSERT INTO session/)
    expect(query?.values).not.toContain(sessionId)
    expect(JSON.stringify(query?.values)).not.toContain(sessionId)
    const hash = query?.values[0]
    expect(Buffer.isBuffer(hash) && hash.equals(sha256(sessionId))).toBe(true)
    expect(query?.values).toEqual([
      sha256(sessionId),
      '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
      'reader@contoso.example',
      ['reader'],
      Buffer.from('ciphertext'),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      'kc-session-1',
      createdAt,
      null,
      new Date('2026-10-19T08:15:00.000Z'),
      new Date('2026-10-19T16:00:00.000Z'),
    ])
  })

  it('rotates at login: the replaced session is ended in the same statement', async () => {
    const { db, queries } = fakeDb({ rows: [], rowCount: 1 })
    await createSessionStore(db).create(newSession(), { replaces: 'previous-cookie-value' })

    expect(queries).toHaveLength(1)
    expect(queries[0]?.text).toMatch(/UPDATE session[\s\S]*end_reason = 'rotated'[\s\S]*INSERT INTO session/)
    expect(queries[0]?.values[9]).toEqual(sha256('previous-cookie-value'))
  })

  it('accepts a signed-in account holding neither role, so it can be told it has no access', async () => {
    const { db, queries } = fakeDb({ rows: [], rowCount: 1 })
    await createSessionStore(db).create(newSession({ roles: [] }))
    expect(queries[0]?.values[3]).toEqual([])
  })

  it('accepts both roles', async () => {
    const { db, queries } = fakeDb({ rows: [], rowCount: 1 })
    await createSessionStore(db).create(newSession({ roles: ['reader', 'report_admin'] }))
    expect(queries[0]?.values[3]).toEqual(['reader', 'report_admin'])
  })

  it.each([
    ['an IV that is not 96 bits', { iv: Buffer.alloc(11) }, /IV/],
    ['a GCM tag that is not 128 bits', { tag: Buffer.alloc(15) }, /tag/],
    ['an empty ciphertext', { ciphertext: Buffer.alloc(0) }, /ciphertext/],
  ])('refuses %s', async (_, part, message) => {
    const { db, queries } = fakeDb()
    const refreshToken = { ...newSession().refreshToken, ...part }
    await expect(createSessionStore(db).create(newSession({ refreshToken }))).rejects.toThrow(message)
    expect(queries).toHaveLength(0)
  })

  it('refuses a role that is not an app role of the dashboard', async () => {
    const { db } = fakeDb()
    const roles = ['owner'] as unknown as NewSession['roles']
    await expect(createSessionStore(db).create(newSession({ roles }))).rejects.toThrow(/role/)
  })

  it('refuses an idle expiry later than the absolute expiry', async () => {
    const { db } = fakeDb()
    const session = newSession({ idleExpiresAt: new Date('2026-10-19T16:00:00.001Z') })
    await expect(createSessionStore(db).create(session)).rejects.toThrow(/idle/)
  })

  it('accepts an idle expiry equal to the absolute expiry', async () => {
    const { db } = fakeDb({ rows: [], rowCount: 1 })
    const session = newSession({ idleExpiresAt: new Date('2026-10-19T16:00:00.000Z') })
    await expect(createSessionStore(db).create(session)).resolves.toBeUndefined()
  })
})

describe('session store findLive', () => {
  const row = {
    subject_oid: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    account_name: 'reader@contoso.example',
    roles: ['reader', 'report_admin'],
    refresh_token_ciphertext: Buffer.from('ciphertext'),
    refresh_token_iv: Buffer.alloc(12, 1),
    refresh_token_tag: Buffer.alloc(16, 2),
    idp_session_id: 'kc-session-1',
    created_at: createdAt,
    last_seen_at: new Date('2026-10-19T08:05:00.000Z'),
    idle_expires_at: new Date('2026-10-19T08:20:00.000Z'),
    absolute_expires_at: new Date('2026-10-19T16:00:00.000Z'),
  }

  it('looks the session up by hash with the injected instant and maps the row', async () => {
    const { db, queries } = fakeDb({ rows: [row] })
    const now = new Date('2026-10-19T08:10:00.000Z')
    const found = await createSessionStore(db).findLive(sessionId, now)

    expect(queries[0]?.text).toMatch(/ended_at IS NULL/)
    expect(queries[0]?.text).toMatch(/idle_expires_at > \$2/)
    expect(queries[0]?.text).toMatch(/absolute_expires_at > \$2/)
    expect(queries[0]?.values).toEqual([sha256(sessionId), now])
    expect(found).toEqual({
      subjectOid: row.subject_oid,
      accountName: row.account_name,
      roles: ['reader', 'report_admin'],
      refreshToken: { ciphertext: row.refresh_token_ciphertext, iv: row.refresh_token_iv, tag: row.refresh_token_tag },
      idpSessionId: 'kc-session-1',
      createdAt,
      lastSeenAt: row.last_seen_at,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
    })
  })

  it('answers null when no live session holds that hash', async () => {
    const { db } = fakeDb({ rows: [] })
    expect(await createSessionStore(db).findLive(sessionId, createdAt)).toBeNull()
  })

  it('refuses a stored role it does not know rather than granting it', async () => {
    const { db } = fakeDb({ rows: [{ ...row, roles: ['reader', 'owner'] }] })
    await expect(createSessionStore(db).findLive(sessionId, createdAt)).rejects.toThrow(/role/)
  })
})

describe('session store touch', () => {
  const now = new Date('2026-10-19T08:10:00.000Z')
  const idleExpiresAt = new Date('2026-10-19T08:25:00.000Z')

  it('slides the idle expiry, capped at the absolute expiry, only on a live session', async () => {
    const { db, queries } = fakeDb({ rows: [], rowCount: 1 })
    expect(await createSessionStore(db).touch(sessionId, now, idleExpiresAt)).toBe(true)
    expect(queries[0]?.text).toMatch(/LEAST\(\$3, absolute_expires_at\)/)
    expect(queries[0]?.text).toMatch(/ended_at IS NULL/)
    expect(queries[0]?.values).toEqual([sha256(sessionId), now, idleExpiresAt])
  })

  it('answers false when the session is no longer live', async () => {
    const { db } = fakeDb({ rows: [], rowCount: 0 })
    expect(await createSessionStore(db).touch(sessionId, now, idleExpiresAt)).toBe(false)
  })

  it('answers false when the driver reports no row count', async () => {
    const { db } = fakeDb({ rows: [], rowCount: null as unknown as number })
    expect(await createSessionStore(db).touch(sessionId, now, idleExpiresAt)).toBe(false)
  })
})

describe('session store end', () => {
  const now = new Date('2026-10-19T09:00:00.000Z')

  it('ends the session and returns the Keycloak session to log out of', async () => {
    const { db, queries } = fakeDb({ rows: [{ idp_session_id: 'kc-session-1' }] })
    expect(await createSessionStore(db).end(sessionId, now, 'logout')).toBe('kc-session-1')
    expect(queries[0]?.text).toMatch(/SET ended_at = \$2, end_reason = \$3/)
    expect(queries[0]?.values).toEqual([sha256(sessionId), now, 'logout'])
  })

  it('answers null for a session already ended, so reusing the cookie stays refused', async () => {
    const { db } = fakeDb({ rows: [] })
    expect(await createSessionStore(db).end(sessionId, now, 'idle')).toBeNull()
  })

  it('refuses an end reason outside the stored set', async () => {
    const { db } = fakeDb()
    const reason = 'whim' as unknown as 'logout'
    await expect(createSessionStore(db).end(sessionId, now, reason)).rejects.toThrow(/reason/)
  })
})
