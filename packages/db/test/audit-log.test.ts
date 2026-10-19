/* ST-1 AC-5: an access-denied audit event is recorded for the account. The audit log is
 * append-only (UPDATE, DELETE and TRUNCATE are rejected by triggers, even for the owner)
 * and hash-chained, so a tampered, removed or reordered row is detectable. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AUDIT_EVENT_TYPES, recordAuditEvent, verifyAuditChain } from '../src/audit-log.js'
import { createTestDatabase, databaseUrl, fixedClock, sqlState, type TestDatabase } from './support/database.js'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const GENESIS = Buffer.alloc(32)

describe.skipIf(!databaseUrl)('audit log', () => {
  let t: TestDatabase
  const clock = fixedClock('2026-10-19T08:00:00.123Z')

  beforeAll(async () => {
    t = await createTestDatabase()
  })
  afterAll(async () => {
    await t?.drop()
  })
  beforeEach(async () => {
    /* Rows cannot be deleted through the triggers; the superuser lifts them only to reset between tests. */
    await t.pool.query('ALTER TABLE audit_event DISABLE TRIGGER USER')
    await t.pool.query('DELETE FROM audit_event')
    await t.pool.query('ALTER TABLE audit_event ENABLE TRIGGER USER')
  })

  it('names the ST-1 event types', () => {
    expect(AUDIT_EVENT_TYPES).toEqual(
      expect.arrayContaining(['access_denied', 'sign_in', 'sign_in_failed', 'sign_out', 'session_expired']),
    )
  })

  it('records an access-denied event for the signed-in account with the trace ID and the clock instant', async () => {
    const recorded = await recordAuditEvent(t.db, clock, {
      type: 'access_denied',
      actor: 'outsider@contoso.example',
      traceId: TRACE,
      detail: { reason: 'no_reader_or_admin_role' },
    })
    expect(recorded.id).toBeGreaterThan(0)
    expect(recorded.hash).toHaveLength(32)

    const { rows } = await t.pool.query('SELECT * FROM audit_event')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      event_type: 'access_denied',
      actor: 'outsider@contoso.example',
      trace_id: TRACE,
      detail: { reason: 'no_reader_or_admin_role' },
    })
    expect(rows[0].occurred_at.toISOString()).toBe('2026-10-19T08:00:00.123Z')
    expect(Buffer.compare(rows[0].prev_hash, GENESIS)).toBe(0)
    expect(Buffer.compare(rows[0].hash, recorded.hash)).toBe(0)
  })

  it('chains each event to the hash of the one before it', async () => {
    const first = await recordAuditEvent(t.db, clock, { type: 'sign_in', actor: 'a@contoso.example', traceId: TRACE })
    const second = await recordAuditEvent(t.db, clock, { type: 'sign_out', actor: 'a@contoso.example', traceId: TRACE })
    const { rows } = await t.pool.query('SELECT id, prev_hash, hash FROM audit_event ORDER BY id')
    expect(rows.map((r) => Number(r.id))).toEqual([first.id, second.id])
    expect(Buffer.compare(rows[1].prev_hash, first.hash)).toBe(0)
    expect(first.hash.equals(second.hash)).toBe(false)
    expect(await verifyAuditChain(t.db)).toEqual({ valid: true })
  })

  it('keeps one unbroken chain when events are written concurrently', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        recordAuditEvent(t.db, clock, { type: 'access_denied', actor: `user${i}@contoso.example`, traceId: TRACE }),
      ),
    )
    expect(await verifyAuditChain(t.db)).toEqual({ valid: true })
  })

  it('verifies an empty log as valid', async () => {
    expect(await verifyAuditChain(t.db)).toEqual({ valid: true })
  })

  it('rejects UPDATE, DELETE and TRUNCATE, even for the table owner', async () => {
    await recordAuditEvent(t.db, clock, { type: 'access_denied', actor: 'x@contoso.example', traceId: TRACE })
    expect(await sqlState(t.pool.query("UPDATE audit_event SET actor = 'someone-else'"))).toBe('P0001')
    expect(await sqlState(t.pool.query('DELETE FROM audit_event'))).toBe('P0001')
    expect(await sqlState(t.pool.query('TRUNCATE audit_event'))).toBe('P0001')
    const { rows } = await t.pool.query('SELECT actor FROM audit_event')
    expect(rows).toEqual([{ actor: 'x@contoso.example' }])
  })

  it('ignores a caller-supplied hash, id or prev_hash', async () => {
    await recordAuditEvent(t.db, clock, { type: 'sign_in', actor: 'a@contoso.example', traceId: TRACE })
    await t.pool.query(
      `INSERT INTO audit_event (occurred_at, event_type, actor, trace_id, prev_hash, hash)
       OVERRIDING SYSTEM VALUE VALUES (now(), 'sign_out', 'a@contoso.example', $1, $2, $2)`,
      [TRACE, Buffer.alloc(32, 7)],
    )
    expect(await verifyAuditChain(t.db)).toEqual({ valid: true })
  })

  describe('detects tampering done around the triggers', () => {
    const seed = async () => {
      for (const actor of ['a', 'b', 'c']) {
        await recordAuditEvent(t.db, clock, {
          type: 'access_denied',
          actor: `${actor}@contoso.example`,
          traceId: TRACE,
        })
      }
      const { rows } = await t.pool.query('SELECT id FROM audit_event ORDER BY id')
      return rows.map((r) => Number(r.id))
    }
    const bypass = async (statement: string, params: unknown[] = []) => {
      await t.pool.query('ALTER TABLE audit_event DISABLE TRIGGER USER')
      try {
        await t.pool.query(statement, params)
      } finally {
        await t.pool.query('ALTER TABLE audit_event ENABLE TRIGGER USER')
      }
    }

    it('an edited row', async () => {
      const ids = await seed()
      await bypass("UPDATE audit_event SET actor = 'forged@contoso.example' WHERE id = $1", [ids[1]])
      expect(await verifyAuditChain(t.db)).toEqual({ valid: false, brokenAtId: ids[1] })
    })

    it('a removed row', async () => {
      const ids = await seed()
      await bypass('DELETE FROM audit_event WHERE id = $1', [ids[1]])
      expect(await verifyAuditChain(t.db)).toEqual({ valid: false, brokenAtId: ids[2] })
    })

    it('a removed first row', async () => {
      const ids = await seed()
      await bypass('DELETE FROM audit_event WHERE id = $1', [ids[0]])
      expect(await verifyAuditChain(t.db)).toEqual({ valid: false, brokenAtId: ids[1] })
    })
  })

  it('rejects an unknown event type, a malformed trace ID and an empty actor', async () => {
    expect(
      await sqlState(recordAuditEvent(t.db, clock, { type: 'made_up' as never, actor: 'a', traceId: TRACE })),
    ).toBe('23514')
    expect(
      await sqlState(recordAuditEvent(t.db, clock, { type: 'access_denied', actor: 'a', traceId: 'not-a-trace' })),
    ).toBe('23514')
    expect(await sqlState(recordAuditEvent(t.db, clock, { type: 'access_denied', actor: '', traceId: TRACE }))).toBe(
      '23514',
    )
  })
})
