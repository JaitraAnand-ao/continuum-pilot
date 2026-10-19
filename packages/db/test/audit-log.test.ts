import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AUDIT_GENESIS_HASH,
  auditEntryHash,
  recordAuditEvent,
  verifyAuditChain,
  type AuditEvent,
  type StoredAuditEntry,
} from '../src/index.js'
import { fakeDb } from './fake-db.js'

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
const accessDenied: AuditEvent = {
  occurredAt: new Date('2026-10-19T08:00:01.250Z'),
  type: 'access_denied',
  actorOid: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  traceId,
  reason: 'no_reader_role',
}

describe('recordAuditEvent (AC-5: an access-denied audit event is recorded)', () => {
  it('inserts the event with bound parameters and lets the database chain it', async () => {
    const { db, queries } = fakeDb({ rows: [], rowCount: 1 })
    await recordAuditEvent(db, accessDenied)

    expect(queries).toHaveLength(1)
    expect(queries[0]?.text).toMatch(/INSERT INTO audit_event/)
    expect(queries[0]?.text).not.toMatch(/RETURNING/)
    expect(queries[0]?.text).not.toMatch(/hash/)
    expect(queries[0]?.values).toEqual([
      accessDenied.occurredAt,
      'access_denied',
      accessDenied.actorOid,
      traceId,
      'no_reader_role',
    ])
  })

  it('records a failed sign-in with its Entra error code and no actor', async () => {
    const { db, queries } = fakeDb({ rows: [], rowCount: 1 })
    await recordAuditEvent(db, { ...accessDenied, type: 'sign_in_failed', actorOid: null, reason: 'AADSTS50126' })
    expect(queries[0]?.values).toEqual([accessDenied.occurredAt, 'sign_in_failed', null, traceId, 'AADSTS50126'])
  })

  it('records an event with no reason', async () => {
    const { db, queries } = fakeDb({ rows: [], rowCount: 1 })
    await recordAuditEvent(db, { ...accessDenied, type: 'sign_out', reason: null })
    expect(queries[0]?.values[4]).toBeNull()
  })

  it.each([
    ['a trace ID that is not 32 lowercase hex digits', { traceId: '4BF92F3577B34DA6A3CE929D0E0E4736' }, /trace/],
    ['a trace ID one digit short', { traceId: traceId.slice(1) }, /trace/],
    ['a reason that could carry personal data', { reason: 'denied for jane.doe@contoso.example' }, /reason/],
    ['a reason longer than 64 characters', { reason: 'x'.repeat(65) }, /reason/],
    ['an actor that is not an Entra object ID', { actorOid: 'jane.doe@contoso.example' }, /actor/],
    ['an unknown event type', { type: 'report_viewed' as AuditEvent['type'] }, /type/],
  ])('refuses %s', async (_, change, message) => {
    const { db, queries } = fakeDb()
    await expect(recordAuditEvent(db, { ...accessDenied, ...change })).rejects.toThrow(message)
    expect(queries).toHaveLength(0)
  })

  it('accepts a reason of exactly 64 characters', async () => {
    const { db } = fakeDb({ rows: [], rowCount: 1 })
    await expect(recordAuditEvent(db, { ...accessDenied, reason: 'x'.repeat(64) })).resolves.toBeUndefined()
  })
})

/* The chain formula, written out independently of the implementation: the same text the
 * audit_event trigger hashes in Postgres. */
function expectedHash(prev: Buffer, seq: number, event: AuditEvent): Buffer {
  const at = event.occurredAt.toISOString().replace('Z', '000Z')
  const payload = [seq, at, event.type, event.actorOid ?? '', event.traceId, event.reason ?? ''].join('|')
  return createHash('sha256').update(prev).update(payload, 'utf8').digest()
}

function chainOf(...events: AuditEvent[]): StoredAuditEntry[] {
  const entries: StoredAuditEntry[] = []
  let prev = Buffer.alloc(32)
  events.forEach((event, index) => {
    const hash = expectedHash(prev, index + 1, event)
    entries.push({ ...event, seq: index + 1, prevHash: prev, hash })
    prev = hash
  })
  return entries
}

describe('audit hash chain', () => {
  const signIn: AuditEvent = { ...accessDenied, type: 'sign_in', reason: null }
  const signOut: AuditEvent = { ...accessDenied, type: 'sign_out', actorOid: null, reason: 'user' }

  it('starts from 32 zero bytes', () => {
    expect(AUDIT_GENESIS_HASH.equals(Buffer.alloc(32))).toBe(true)
  })

  it('hashes the previous hash then the pipe-joined fields with microsecond UTC time', () => {
    expect(auditEntryHash(AUDIT_GENESIS_HASH, { ...accessDenied, seq: 1 })).toEqual(
      expectedHash(Buffer.alloc(32), 1, accessDenied),
    )
  })

  it('verifies an intact chain', () => {
    expect(verifyAuditChain(chainOf(accessDenied, signIn, signOut))).toEqual({ ok: true, entries: 3 })
  })

  it('verifies an empty chain', () => {
    expect(verifyAuditChain([])).toEqual({ ok: true, entries: 0 })
  })

  it('finds an edited entry', () => {
    const chain = chainOf(accessDenied, signIn, signOut)
    chain[1] = { ...chain[1]!, reason: 'edited' }
    expect(verifyAuditChain(chain)).toEqual({ ok: false, brokenAtSeq: 2 })
  })

  it('finds a removed entry', () => {
    const chain = chainOf(accessDenied, signIn, signOut)
    expect(verifyAuditChain([chain[0]!, chain[2]!])).toEqual({ ok: false, brokenAtSeq: 3 })
  })

  it('finds a first entry that does not start from the genesis hash', () => {
    const chain = chainOf(accessDenied, signIn)
    expect(verifyAuditChain(chain.slice(1))).toEqual({ ok: false, brokenAtSeq: 2 })
  })

  it('finds an entry whose stored previous hash was rewritten to match', () => {
    const chain = chainOf(accessDenied, signIn)
    const forged = Buffer.alloc(32, 7)
    chain[1] = { ...chain[1]!, prevHash: forged, hash: expectedHash(forged, 2, signIn) }
    expect(verifyAuditChain(chain)).toEqual({ ok: false, brokenAtSeq: 2 })
  })
})
