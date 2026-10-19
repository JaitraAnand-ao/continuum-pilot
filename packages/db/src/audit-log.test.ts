import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuditLog, verifyAuditChain } from './audit-log.js'
import { createDatabase } from './database.js'
import { DB_ROLES } from './roles.js'
import { FixedClock, migratedOwnerPool, poolAs, testDatabaseUrl } from './test-database.js'

const at = new Date('2026-10-19T08:00:00.000Z')
const traceId = () => randomUUID().replaceAll('-', '')

describe.skipIf(!testDatabaseUrl)('audit log as sr_api, verified as sr_auditor', () => {
  const url = testDatabaseUrl as string
  let owner: pg.Pool
  let api: pg.Pool
  let auditor: pg.Pool
  const clock = new FixedClock(at)

  beforeAll(async () => {
    owner = await migratedOwnerPool(url)
    api = poolAs(url, DB_ROLES.api)
    auditor = poolAs(url, DB_ROLES.auditor)
  })
  afterAll(async () => {
    await api?.end()
    await auditor?.end()
    await owner?.end()
  })

  it('records an access-denied event for the signed-in account (AC-5)', async () => {
    const trace = traceId()
    await createAuditLog(createDatabase(api), clock).record({
      type: 'access_denied',
      subject: 'oid-outsider',
      username: 'outsider@contoso.example',
      traceId: trace,
      detail: { route: '/api/reports/daily/2026-10-18' },
    })
    const { rows } = await owner.query(
      'select event_type, subject, username, occurred_at, detail from audit_events where trace_id = $1',
      [trace],
    )
    expect(rows).toEqual([
      {
        event_type: 'access_denied',
        subject: 'oid-outsider',
        username: 'outsider@contoso.example',
        occurred_at: at,
        detail: { route: '/api/reports/daily/2026-10-18' },
      },
    ])
  })

  it('records a sign-in failure with no account', async () => {
    const trace = traceId()
    await createAuditLog(createDatabase(api), clock).record({
      type: 'sign_in_failed',
      subject: null,
      username: null,
      traceId: trace,
      detail: { entraError: 'AADSTS50126' },
    })
    const { rows } = await owner.query('select subject, detail from audit_events where trace_id = $1', [trace])
    expect(rows).toEqual([{ subject: null, detail: { entraError: 'AADSTS50126' } }])
  })

  it('refuses an unknown event type', async () => {
    await expect(
      createAuditLog(createDatabase(api), clock).record({
        type: 'deleted_everything' as 'sign_in',
        subject: null,
        username: null,
        traceId: traceId(),
      }),
    ).rejects.toThrow()
  })

  it('chains every event to the one before it by SHA-256, also under concurrent writers', async () => {
    const log = createAuditLog(createDatabase(api), clock)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.record({ type: i % 2 ? 'sign_in' : 'sign_out', subject: `oid-${i}`, username: null, traceId: traceId() }),
      ),
    )
    const result = await verifyAuditChain(createDatabase(auditor))
    expect(result.ok).toBe(true)
    expect(result.length).toBeGreaterThanOrEqual(20)
    const { rows } = await owner.query<{ position: string; prev_hash: Buffer; hash: Buffer }>(
      'select position, prev_hash, hash from audit_events order by position',
    )
    expect(rows[0]?.position).toBe('1')
    expect(rows[0]?.prev_hash.equals(Buffer.alloc(32))).toBe(true)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.prev_hash.equals(rows[i - 1]!.hash)).toBe(true)
      expect(Number(rows[i]?.position)).toBe(i + 1)
    }
  })

  it('detects a forged row', async () => {
    const forged = await owner.connect()
    try {
      await forged.query('begin')
      await forged.query('alter table audit_events disable trigger audit_events_immutable')
      await forged.query(`update audit_events set username = 'someone-else' where position = 1`)
      const result = await verifyAuditChain(createDatabase(forged as unknown as pg.Pool))
      expect(result).toEqual({ ok: false, length: expect.any(Number), brokenAt: 1 })
    } finally {
      await forged.query('rollback')
      forged.release()
    }
  })

  it('refuses UPDATE, DELETE and TRUNCATE even to the owner', async () => {
    await expect(owner.query(`update audit_events set username = 'x'`)).rejects.toThrow(/append-only/)
    await expect(owner.query('delete from audit_events')).rejects.toThrow(/append-only/)
    await expect(owner.query('truncate audit_events')).rejects.toThrow(/append-only/)
  })

  it('sr_api may append but not read, change or delete the audit log', async () => {
    await expect(api.query('select * from audit_events')).rejects.toThrow(/permission denied/)
    await expect(api.query(`update audit_events set username = 'x'`)).rejects.toThrow(/permission denied/)
    await expect(api.query('delete from audit_events')).rejects.toThrow(/permission denied/)
  })

  it('sr_auditor may read but not append', async () => {
    await expect(auditor.query('select count(*) from audit_events')).resolves.toBeDefined()
    await expect(
      createAuditLog(createDatabase(auditor), clock).record({
        type: 'sign_in',
        subject: 'x',
        username: null,
        traceId: traceId(),
      }),
    ).rejects.toThrow(/permission denied/)
  })
})
