import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase } from './database.js'
import { LOGIN_TRANSACTION_LIMIT_MS, createLoginTransactionStore } from './login-transaction-store.js'
import { DB_ROLES } from './roles.js'
import { FixedClock, migratedOwnerPool, poolAs, testDatabaseUrl } from './test-database.js'
import { hashSecret, open, seal } from './token-seal.js'

const key = randomBytes(32)
const start = new Date('2026-10-19T08:00:00.000Z')

function transaction() {
  const transactionId = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  return {
    transactionId,
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    verifier,
    codeVerifier: seal(key, verifier, hashSecret(transactionId)),
  }
}

describe.skipIf(!testDatabaseUrl)('login transaction store (state, nonce, PKCE) as sr_api', () => {
  const url = testDatabaseUrl as string
  let owner: pg.Pool
  let api: pg.Pool
  const clock = new FixedClock(start)

  beforeAll(async () => {
    owner = await migratedOwnerPool(url)
    api = poolAs(url, DB_ROLES.api)
  })
  afterAll(async () => {
    await api?.end()
    await owner?.end()
  })

  const store = () => createLoginTransactionStore(createDatabase(api), clock)

  it('hands back the PKCE verifier and checks the nonce for a matching state', async () => {
    clock.set(start)
    const t = transaction()
    await store().begin(t)
    const consumed = await store().consume({ transactionId: t.transactionId, state: t.state })
    expect(consumed).not.toBeNull()
    expect(open(key, consumed!.codeVerifier, hashSecret(t.transactionId))).toBe(t.verifier)
    expect(consumed!.matchesNonce(t.nonce)).toBe(true)
    expect(consumed!.matchesNonce(`${t.nonce}x`)).toBe(false)
    expect(consumed!.matchesNonce('')).toBe(false)
  })

  it('stores no state, nonce, verifier or transaction ID in clear', async () => {
    clock.set(start)
    const t = transaction()
    await store().begin(t)
    const { rows } = await owner.query('select * from login_transactions where id_hash = $1', [
      hashSecret(t.transactionId),
    ])
    const dump = Object.values(rows[0] as Record<string, unknown>)
      .map((v) => (Buffer.isBuffer(v) ? v.toString('latin1') : String(v)))
      .join('|')
    for (const secret of [t.transactionId, t.state, t.nonce, t.verifier]) expect(dump).not.toContain(secret)
  })

  it('rejects a tampered state and burns the transaction', async () => {
    clock.set(start)
    const t = transaction()
    await store().begin(t)
    expect(await store().consume({ transactionId: t.transactionId, state: `${t.state}x` })).toBeNull()
    expect(await store().consume({ transactionId: t.transactionId, state: t.state })).toBeNull()
  })

  it('is single-use', async () => {
    clock.set(start)
    const t = transaction()
    await store().begin(t)
    expect(await store().consume({ transactionId: t.transactionId, state: t.state })).not.toBeNull()
    expect(await store().consume({ transactionId: t.transactionId, state: t.state })).toBeNull()
  })

  it('returns null for an unknown transaction', async () => {
    expect(await store().consume({ transactionId: 'nope', state: 'nope' })).toBeNull()
  })

  it('expires after 10 minutes: usable 1 ms before, refused at the limit', async () => {
    const a = transaction()
    const b = transaction()
    clock.set(start)
    await store().begin(a)
    await store().begin(b)
    clock.set(new Date(start.getTime() + LOGIN_TRANSACTION_LIMIT_MS - 1))
    expect(await store().consume({ transactionId: a.transactionId, state: a.state })).not.toBeNull()
    clock.set(new Date(start.getTime() + LOGIN_TRANSACTION_LIMIT_MS))
    expect(await store().consume({ transactionId: b.transactionId, state: b.state })).toBeNull()
  })

  it('purges abandoned transactions past their limit', async () => {
    const t = transaction()
    clock.set(new Date('2026-10-21T08:00:00.000Z'))
    await store().begin(t)
    clock.advance(LOGIN_TRANSACTION_LIMIT_MS)
    expect(await store().purgeExpired()).toBeGreaterThanOrEqual(1)
    const { rowCount } = await owner.query('select 1 from login_transactions where id_hash = $1', [
      hashSecret(t.transactionId),
    ])
    expect(rowCount).toBe(0)
  })

  it('sr_api cannot rewrite a transaction', async () => {
    await expect(api.query('update login_transactions set state_hash = state_hash')).rejects.toThrow(
      /permission denied/,
    )
  })
})
