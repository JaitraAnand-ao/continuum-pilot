import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuditLog, findAuditChainBreak, type AuditLog } from '../audit-log.js'
import { connect } from '../client.js'
import { migratedPool, noDatabase, sqlState } from './db.js'

const traceId = () => randomUUID().replaceAll('-', '')

describe.skipIf(noDatabase)('audit log (AC-5)', () => {
  let pool: pg.Pool
  let audit: AuditLog

  beforeAll(async () => {
    pool = await migratedPool()
    audit = createAuditLog(connect(pool))
  })
  afterAll(async () => {
    await pool?.end()
  })

  it('records an access-denied event for the signed-in account', async () => {
    const actorOid = randomUUID()
    const trace = traceId()
    const occurredAt = new Date('2026-10-19T08:00:00.123Z')
    const { id } = await audit.record({
      type: 'access_denied',
      actorOid,
      actorName: 'outsider@contoso.example',
      target: 'GET /api/reports/daily/{date}',
      traceId: trace,
      occurredAt,
    })

    const row = (await pool.query('SELECT * FROM audit_events WHERE id = $1', [id])).rows[0]
    expect(row).toMatchObject({
      event_type: 'access_denied',
      actor_oid: actorOid,
      actor_name: 'outsider@contoso.example',
      target: 'GET /api/reports/daily/{date}',
      trace_id: trace,
      occurred_at: occurredAt,
    })
    expect(row.hash).toHaveLength(32)
  })

  it('chains each event to the hash of the one before it', async () => {
    const event = { type: 'access_denied' as const, actorName: null, target: null, occurredAt: new Date() }
    const first = await audit.record({ ...event, actorOid: randomUUID(), traceId: traceId() })
    const second = await audit.record({ ...event, actorOid: randomUUID(), traceId: traceId() })

    const rows = (
      await pool.query('SELECT id, prev_hash, hash FROM audit_events WHERE id IN ($1, $2) ORDER BY id', [
        first.id,
        second.id,
      ])
    ).rows
    const between = (
      await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE id > $1 AND id < $2', [first.id, second.id])
    ).rows[0].n
    if (between === 0) expect(rows[1].prev_hash).toEqual(rows[0].hash)
    expect(rows[1].hash).not.toEqual(rows[0].hash)
    expect(await findAuditChainBreak(connect(pool))).toBeNull()
  })

  it('ignores a hash the caller tries to supply', async () => {
    const forged = Buffer.alloc(32, 7)
    const { rows } = await pool.query(
      `INSERT INTO audit_events (occurred_at, event_type, actor_oid, trace_id, prev_hash, hash)
       VALUES (now(), 'access_denied', $1, $2, $3, $3) RETURNING hash, prev_hash`,
      [randomUUID(), traceId(), forged],
    )
    expect(rows[0].hash).not.toEqual(forged)
    expect(rows[0].prev_hash).not.toEqual(forged)
    expect(await findAuditChainBreak(connect(pool))).toBeNull()
  })

  it('rejects UPDATE, DELETE and TRUNCATE even from the owner', async () => {
    const { id } = await audit.record({
      type: 'access_denied',
      actorOid: randomUUID(),
      actorName: null,
      target: null,
      traceId: traceId(),
      occurredAt: new Date(),
    })
    expect(await sqlState(() => pool.query("UPDATE audit_events SET actor_name = 'x' WHERE id = $1", [id]))).toBe(
      'P0001',
    )
    expect(await sqlState(() => pool.query('DELETE FROM audit_events WHERE id = $1', [id]))).toBe('P0001')
    expect(await sqlState(() => pool.query('TRUNCATE audit_events'))).toBe('P0001')
  })

  it('detects a row altered behind the triggers', async () => {
    const { id } = await audit.record({
      type: 'access_denied',
      actorOid: randomUUID(),
      actorName: 'victim@contoso.example',
      target: null,
      traceId: traceId(),
      occurredAt: new Date(),
    })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE audit_events DISABLE TRIGGER USER')
      await client.query("UPDATE audit_events SET actor_name = 'someone-else' WHERE id = $1", [id])
      expect(await findAuditChainBreak(connect(client))).toBe(id)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect(await findAuditChainBreak(connect(pool))).toBeNull()
  })

  it('rejects an unknown event type and a malformed trace ID', async () => {
    const event = {
      actorOid: randomUUID(),
      actorName: null,
      target: null,
      occurredAt: new Date(),
    }
    expect(
      await sqlState(() => audit.record({ ...event, type: 'made_up' as 'access_denied', traceId: traceId() })),
    ).toBe('23514')
    expect(await sqlState(() => audit.record({ ...event, type: 'access_denied', traceId: 'not-a-trace' }))).toBe(
      '23514',
    )
  })
})
