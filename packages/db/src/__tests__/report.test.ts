import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, migratedPool, noDatabase, sqlState } from './db.js'

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'
const RAISE_EXCEPTION = 'P0001'

const HASH = 'a'.repeat(64)

interface ReportRow {
  report_date: string
  window_start: string
  window_end: string
  status: string
  missing_sources: string[]
  total: number
  successful: number
  failed: number
  snapshot: unknown
  content_hash: string
  published_at: string
}

const signIn = (id: string, errorCode = 0) => ({
  id,
  createdDateTime: '2026-10-11T23:59:59.999Z',
  signInEventType: 'interactiveUser',
  errorCode,
  conditionalAccessPolicies: [{ id: 'p1', displayName: 'Require MFA', result: 'success' }],
  deviceDetail: { deviceId: 'd1', operatingSystem: 'Windows', browser: 'Edge', isCompliant: true, isManaged: true },
})

const row = (overrides: Partial<ReportRow> = {}): ReportRow => ({
  report_date: '2026-10-11',
  window_start: '2026-10-11T00:00:00.000Z',
  window_end: '2026-10-12T00:00:00.000Z',
  status: 'complete',
  missing_sources: [],
  total: 2,
  successful: 1,
  failed: 1,
  snapshot: { signIns: [signIn('a'), signIn('b', 50126)], riskDetections: [] },
  content_hash: HASH,
  published_at: '2026-10-12T02:00:00.000Z',
  ...overrides,
})

/* The statement the report worker publishes with: a second publish for the date is a no-op. */
const insertReport = (client: pg.PoolClient, r: ReportRow) =>
  client.query(
    `INSERT INTO report (report_date, window_start, window_end, status, missing_sources,
                         total, successful, failed, snapshot, content_hash, published_at)
     VALUES ($1::date, $2::timestamptz, $3::timestamptz, $4, $5::text[], $6, $7, $8, $9::jsonb, $10, $11::timestamptz)
     ON CONFLICT (report_date) DO NOTHING`,
    [
      r.report_date,
      r.window_start,
      r.window_end,
      r.status,
      r.missing_sources,
      r.total,
      r.successful,
      r.failed,
      JSON.stringify(r.snapshot),
      r.content_hash,
      r.published_at,
    ],
  )

const recordNotGenerated = (client: pg.PoolClient, date: string, missing: string[], at: string) =>
  client.query(
    `INSERT INTO report_not_generated (report_date, missing_sources, recorded_at)
     VALUES ($1::date, $2::text[], $3::timestamptz)
     ON CONFLICT (report_date) DO UPDATE
       SET missing_sources = EXCLUDED.missing_sources, recorded_at = EXCLUDED.recorded_at`,
    [date, missing, at],
  )

const ALL_SOURCES = [
  'signIns.interactiveUser',
  'signIns.nonInteractiveUser',
  'signIns.servicePrincipal',
  'signIns.managedIdentity',
  'identityProtection.riskDetections',
]

describe.skipIf(noDatabase)('report storage (ST-2)', () => {
  let pool: pg.Pool
  let owner: string

  beforeAll(async () => {
    pool = await migratedPool()
    owner = (await pool.query('SELECT current_user AS u')).rows[0].u
  })
  afterAll(async () => {
    await pool?.end()
  })

  /* As the migrating owner, inside a transaction that is rolled back. */
  const asOwner = <T>(fn: (client: pg.PoolClient) => Promise<T>) => asRole(pool, owner, fn)
  const rejects = (r: ReportRow) => asOwner((c) => sqlState(() => insertReport(c, r)))

  describe('publishing (AC-1, AC-4)', () => {
    it('the report worker publishes once; a re-run leaves the one report and its hash unchanged', async () => {
      await asRole(pool, 'sr_report_worker', async (c) => {
        expect((await insertReport(c, row())).rowCount).toBe(1)
        const rerun = await insertReport(c, row({ content_hash: 'f'.repeat(64), published_at: '2026-10-12T06:00:00Z' }))
        expect(rerun.rowCount).toBe(0)
        const { rows } = await c.query(
          `SELECT count(*)::int AS n, max(content_hash) AS hash FROM report WHERE report_date = '2026-10-11'`,
        )
        expect(rows[0]).toEqual({ n: 1, hash: HASH })
      })
    })

    it('reads the snapshot back exactly as it was written', async () => {
      await asOwner(async (c) => {
        await insertReport(c, row())
        const { rows } = await c.query(`SELECT snapshot FROM report WHERE report_date = '2026-10-11'`)
        expect(rows[0].snapshot).toEqual(row().snapshot)
      })
    })

    it('rejects every UPDATE of a published report, even by the owner', async () => {
      for (const statement of [
        `UPDATE report SET content_hash = '${'b'.repeat(64)}'`,
        `UPDATE report SET status = 'complete', missing_sources = '{}'`,
        `UPDATE report SET published_at = published_at`,
      ]) {
        const state = await asOwner(async (c) => {
          await insertReport(c, row())
          return sqlState(() => c.query(statement))
        })
        expect(state).toBe(RAISE_EXCEPTION)
      }
    })

    it('rejects TRUNCATE of the reports', async () => {
      /* By the immutability trigger, or first by the ST-9 risk flags' foreign keys (0A000). */
      expect([RAISE_EXCEPTION, '0A000']).toContain(await asOwner((c) => sqlState(() => c.query('TRUNCATE report'))))
    })
  })

  describe('the window is exactly the UTC day (AC-1)', () => {
    it('accepts 00:00Z of D up to 00:00Z of D+1', async () => {
      expect(await rejects(row())).toBeNull()
    })

    it('rejects a start or end one millisecond off, or a window in another zone', async () => {
      for (const r of [
        row({ window_start: '2026-10-10T23:59:59.999Z' }),
        row({ window_start: '2026-10-11T00:00:00.001Z' }),
        row({ window_end: '2026-10-11T23:59:59.999Z' }),
        row({ window_end: '2026-10-12T00:00:00.001Z' }),
        row({ window_start: '2026-10-11T00:00:00+02:00', window_end: '2026-10-12T00:00:00+02:00' }),
      ]) {
        expect(await rejects(r)).toBe(CHECK_VIOLATION)
      }
    })

    it('rejects a report published before its window has closed', async () => {
      expect(await rejects(row({ published_at: '2026-10-11T23:59:59.999Z' }))).toBe(CHECK_VIOLATION)
      expect(await rejects(row({ published_at: '2026-10-12T00:00:00.000Z' }))).toBeNull()
    })
  })

  describe('a report is never shown as complete when a source is missing (AC-5)', () => {
    it('accepts an incomplete report naming Identity Protection as missing', async () => {
      expect(
        await rejects(row({ status: 'incomplete', missing_sources: ['identityProtection.riskDetections'] })),
      ).toBeNull()
    })

    it('rejects complete with a missing source, incomplete with none, and an unknown status or source', async () => {
      for (const r of [
        row({ status: 'complete', missing_sources: ['identityProtection.riskDetections'] }),
        row({ status: 'incomplete', missing_sources: [] }),
        row({ status: 'partial' }),
        row({ status: 'incomplete', missing_sources: ['auditLogs.directoryAudits'] }),
      ]) {
        expect(await rejects(r)).toBe(CHECK_VIOLATION)
      }
    })
  })

  describe('the figures reconcile to the snapshot (AC-2, AC-7)', () => {
    it('accepts a day with no sign-ins whose totals are zero', async () => {
      expect(
        await rejects(row({ total: 0, successful: 0, failed: 0, snapshot: { signIns: [], riskDetections: [] } })),
      ).toBeNull()
    })

    it('rejects a total that is not successful plus failed, or not the snapshot size', async () => {
      for (const r of [
        row({ total: 2, successful: 2, failed: 1 }),
        row({ total: 2, successful: 1, failed: 0 }),
        row({ total: 3, successful: 2, failed: 1 }),
        row({ total: 1, successful: 0, failed: 1 }),
        row({ total: 0, successful: 0, failed: 0, snapshot: { riskDetections: [] } }),
        row({ total: 0, successful: 0, failed: 0, snapshot: { signIns: {}, riskDetections: [] } }),
      ]) {
        expect(await rejects(r)).toBe(CHECK_VIOLATION)
      }
    })

    it('rejects negative counts', async () => {
      expect(
        await rejects(row({ total: 0, successful: 1, failed: -1, snapshot: { signIns: [], riskDetections: [] } })),
      ).toBe(CHECK_VIOLATION)
    })

    it('rejects a content hash that is not a lowercase hex SHA-256', async () => {
      for (const content_hash of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
        expect(await rejects(row({ content_hash }))).toBe(CHECK_VIOLATION)
      }
    })
  })

  describe('a day that could not be generated (AC-5)', () => {
    it('the report worker records it and may record it again later', async () => {
      await asRole(pool, 'sr_report_worker', async (c) => {
        await recordNotGenerated(c, '2026-10-05', ALL_SOURCES, '2026-10-06T06:59:00Z')
        await recordNotGenerated(c, '2026-10-05', ALL_SOURCES, '2026-10-06T07:00:00Z')
        const { rows } = await c.query(
          `SELECT count(*)::int AS n, max(recorded_at) AS at FROM report_not_generated WHERE report_date = '2026-10-05'`,
        )
        expect(rows[0]).toEqual({ n: 1, at: new Date('2026-10-06T07:00:00Z') })
      })
    })

    it('must name at least one known missing source', async () => {
      for (const missing of [[], ['auditLogs.directoryAudits']]) {
        expect(
          await asOwner((c) => sqlState(() => recordNotGenerated(c, '2026-10-05', missing, '2026-10-06T07:00:00Z'))),
        ).toBe(CHECK_VIOLATION)
      }
    })
  })

  describe('per-role grants (AD-10)', () => {
    it('the report worker cannot alter or remove a published report', async () => {
      for (const statement of [`UPDATE report SET total = 0`, `DELETE FROM report`, `TRUNCATE report`]) {
        expect(await asRole(pool, 'sr_report_worker', (c) => sqlState(() => c.query(statement)))).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      }
      expect(
        await asRole(pool, 'sr_report_worker', (c) => sqlState(() => c.query('DELETE FROM report_not_generated'))),
      ).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('the API reads reports and not-generated days but writes neither', async () => {
      await asRole(pool, 'sr_api', async (c) => {
        await c.query('SELECT * FROM report')
        await c.query('SELECT * FROM report_not_generated')
      })
      expect(await asRole(pool, 'sr_api', (c) => sqlState(() => insertReport(c, row())))).toBe(INSUFFICIENT_PRIVILEGE)
      expect(
        await asRole(pool, 'sr_api', (c) =>
          sqlState(() => recordNotGenerated(c, '2026-10-05', ALL_SOURCES, '2026-10-06T07:00:00Z')),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('the mail worker reads counts only, never the snapshot evidence', async () => {
      await asRole(pool, 'sr_mail_worker', (c) =>
        c.query('SELECT report_date, status, missing_sources, total, successful, failed, published_at FROM report'),
      )
      for (const statement of [
        'SELECT snapshot FROM report',
        'SELECT * FROM report',
        'SELECT * FROM report_not_generated',
      ]) {
        expect(await asRole(pool, 'sr_mail_worker', (c) => sqlState(() => c.query(statement)))).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      }
      expect(await asRole(pool, 'sr_mail_worker', (c) => sqlState(() => insertReport(c, row())))).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('grants nothing to PUBLIC', async () => {
      const { rows } = await pool.query(
        `SELECT c.relname AS table, bool_or(a.grantee = 0) AS public
           FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.relname IN ('report', 'report_not_generated') AND c.relnamespace = 'public'::regnamespace
          GROUP BY c.relname ORDER BY c.relname`,
      )
      expect(rows).toEqual([
        { table: 'report', public: false },
        { table: 'report_not_generated', public: false },
      ])
    })
  })
})
