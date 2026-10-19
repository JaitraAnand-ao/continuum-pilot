import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAuditLog,
  createDb,
  readAuditChain,
  runMigrations,
  verifyAuditChain,
  type AuditLog,
  type AuditRow,
} from './index.js'
import { createFreshDatabase, testDatabaseUrl, type FreshDatabase } from './test-support.js'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const T0 = new Date('2026-10-19T08:00:00.123Z')

describe('verifyAuditChain (pure)', () => {
  it('accepts an empty chain', () => {
    expect(verifyAuditChain([])).toEqual({ ok: true, length: 0 })
  })
})

describe.skipIf(!testDatabaseUrl)('audit_events (append-only, hash-chained, on real Postgres)', () => {
  let fresh: FreshDatabase
  let audit: AuditLog
  let db: ReturnType<typeof createDb>

  beforeAll(async () => {
    fresh = await createFreshDatabase(testDatabaseUrl as string)
    db = createDb(fresh.pool)
    await runMigrations(db)
    audit = createAuditLog(db)
  })
  afterAll(async () => {
    await fresh?.drop()
  })

  it('records an access-denied event for the signed-in account (AC-5)', async () => {
    const { id } = await audit.append({
      occurredAt: T0,
      eventType: 'access_denied',
      subject: '11111111-2222-3333-4444-555555555555',
      reason: 'missing_reader_role',
      traceId: TRACE,
    })
    const { rows } = await fresh.pool.query('SELECT * FROM audit_events WHERE id = $1', [id])
    expect(rows[0]).toMatchObject({
      event_type: 'access_denied',
      subject: '11111111-2222-3333-4444-555555555555',
      reason: 'missing_reader_role',
      trace_id: TRACE,
      occurred_at: T0,
    })
  })

  it('records a failed sign-in with the Entra error code and no subject (AC-6)', async () => {
    const { id } = await audit.append({
      occurredAt: T0,
      eventType: 'sign_in_failed',
      subject: null,
      reason: 'AADSTS50126',
      traceId: TRACE,
    })
    const { rows } = await fresh.pool.query('SELECT subject, reason FROM audit_events WHERE id = $1', [id])
    expect(rows[0]).toEqual({ subject: null, reason: 'AADSTS50126' })
  })

  it('chains each event to the previous hash, and the chain verifies', async () => {
    await audit.append({ occurredAt: T0, eventType: 'sign_in', subject: 'a', reason: null, traceId: TRACE })
    await audit.append({ occurredAt: T0, eventType: 'sign_out', subject: 'a', reason: null, traceId: TRACE })
    const chain = await readAuditChain(db)
    expect(chain.length).toBeGreaterThanOrEqual(4)
    expect(chain[0]?.prevHash).toBeNull()
    for (let i = 1; i < chain.length; i++) expect(chain[i]?.prevHash?.equals(chain[i - 1]?.hash as Buffer)).toBe(true)
    expect(verifyAuditChain(chain)).toEqual({ ok: true, length: chain.length })
  })

  it('ignores a caller-supplied hash: the trigger computes it', async () => {
    await fresh.pool.query(
      `INSERT INTO audit_events (occurred_at, event_type, subject, trace_id, prev_hash, hash) VALUES ($1, 'sign_in', 'x', $2, $3, $3)`,
      [T0, TRACE, Buffer.alloc(32, 9)],
    )
    expect(verifyAuditChain(await readAuditChain(db)).ok).toBe(true)
  })

  it('keeps one valid chain under concurrent appends', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        audit.append({
          occurredAt: new Date(T0.getTime() + i),
          eventType: 'access_denied',
          subject: `s${i}`,
          reason: 'missing_reader_role',
          traceId: TRACE,
        }),
      ),
    )
    const chain = await readAuditChain(db)
    expect(verifyAuditChain(chain)).toEqual({ ok: true, length: chain.length })
    expect(new Set(chain.map((r) => r.id)).size).toBe(chain.length)
  })

  it('detects a tampered field, a reordered row and a removed row', async () => {
    const chain = await readAuditChain(db)
    const tampered: AuditRow[] = chain.map((r, i) => (i === 2 ? { ...r, subject: 'someone-else' } : r))
    expect(verifyAuditChain(tampered)).toEqual({ ok: false, brokenAt: chain[2]?.id })
    const removed = chain.filter((_, i) => i !== 1)
    expect(verifyAuditChain(removed)).toEqual({ ok: false, brokenAt: chain[2]?.id })
    const swapped = [chain[1], chain[0], ...chain.slice(2)] as AuditRow[]
    expect(verifyAuditChain(swapped)).toEqual({ ok: false, brokenAt: chain[1]?.id })
    const timeShifted = chain.map((r, i) => (i === 0 ? { ...r, occurredAt: new Date(r.occurredAt.getTime() + 1) } : r))
    expect(verifyAuditChain(timeShifted)).toEqual({ ok: false, brokenAt: chain[0]?.id })
  })

  it('rejects UPDATE, DELETE and TRUNCATE even from the table owner', async () => {
    await expect(fresh.pool.query(`UPDATE audit_events SET subject = 'x'`)).rejects.toThrow(
      'audit_events is append-only',
    )
    await expect(fresh.pool.query(`DELETE FROM audit_events`)).rejects.toThrow('audit_events is append-only')
    await expect(fresh.pool.query(`TRUNCATE audit_events`)).rejects.toThrow('audit_events is append-only')
  })

  it('accepts only known event types, code-shaped reasons and W3C trace ids', async () => {
    const base = { occurredAt: T0, subject: 'a', reason: null, traceId: TRACE } as const
    await expect(audit.append({ ...base, eventType: 'report_viewed' as never })).rejects.toThrow(
      'audit_events_event_type_known',
    )
    await expect(audit.append({ ...base, eventType: 'access_denied', reason: 'Jane Doe was denied' })).rejects.toThrow(
      'audit_events_reason_is_code',
    )
    await expect(audit.append({ ...base, eventType: 'access_denied', traceId: 'not-a-trace' })).rejects.toThrow(
      'audit_events_trace_id_w3c',
    )
    await expect(audit.append({ ...base, eventType: 'access_denied', traceId: '0'.repeat(32) })).rejects.toThrow(
      'audit_events_trace_id_w3c',
    )
  })
})
