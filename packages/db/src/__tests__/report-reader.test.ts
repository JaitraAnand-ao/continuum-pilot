import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect } from '../client.js'
import { createReportReader, type StoredReport } from '../report-reader.js'
import { migratedPool, noDatabase } from './db.js'
import { daySignIns, figuresOf, HASH, insertFigures, insertReport, reconcileState, SCOPES } from './report-fixture.js'

const DATE = '2026-10-11'

const byApp = (a: { appId: string }, b: { appId: string }) => (a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0)
const byCode = (a: { errorCode: number }, b: { errorCode: number }) => a.errorCode - b.errorCode

describe.skipIf(noDatabase)('reading a stored report (ST-3)', () => {
  let pool: pg.Pool
  const signIns = daySignIns(DATE)
  const figures = figuresOf(signIns)

  beforeAll(async () => {
    pool = await migratedPool()
  })
  afterAll(async () => {
    await pool?.end()
  })

  /* Publishes as the report worker, then reads as the API, in one transaction that is rolled back. */
  async function asApiAfter<T>(
    seed: (c: pg.PoolClient) => Promise<void>,
    read: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE sr_report_worker')
      await seed(client)
      expect(await reconcileState(client)).toBeNull()
      await client.query('RESET ROLE')
      await client.query('SET LOCAL ROLE sr_api')
      return await read(client)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  const publishDay = async (c: pg.PoolClient) => {
    await insertReport(c, DATE, signIns)
    await insertFigures(c, DATE, figures)
  }

  const read = (c: pg.PoolClient, date = DATE) => createReportReader(connect(c)).findPublished(date)

  it('reads the date, the 00:00–24:00 UTC window, the generated time and the hash as stored (AC-1)', async () => {
    const report = await asApiAfter(publishDay, (c) => read(c))
    expect(report).toMatchObject({
      reportDate: '2026-10-11',
      windowStart: '2026-10-11T00:00:00.000Z',
      windowEnd: '2026-10-12T00:00:00.000Z',
      publishedAt: '2026-10-12T02:15:30.123Z',
      status: 'complete',
      missingSources: [],
      contentHash: HASH,
    })
  })

  it('reads tiles equal to the snapshot counts, with the number of error codes (AC-1)', async () => {
    const report = (await asApiAfter(publishDay, (c) => read(c))) as StoredReport
    const failed = signIns.filter((s) => s.errorCode !== 0).length
    const codes = new Set(signIns.filter((s) => s.errorCode !== 0).map((s) => s.errorCode)).size
    expect(report.totals).toEqual({ total: signIns.length, successful: signIns.length - failed, failed })
    expect(report.figures?.all).toMatchObject({
      total: signIns.length,
      successful: signIns.length - failed,
      failed,
      errorCodeCount: codes,
    })
  })

  it('reads every application row equal to its snapshot count, busiest first (AC-2)', async () => {
    const report = (await asApiAfter(publishDay, (c) => read(c))) as StoredReport
    for (const scope of SCOPES) {
      const apps = report.figures![scope].applications
      expect([...apps].sort(byApp)).toEqual([...figures[scope].applications].sort(byApp))
      const totals = apps.map((a) => a.total)
      expect(totals).toEqual([...totals].sort((a, b) => b - a))
    }
    expect(report.figures!.all.applications).toHaveLength(33)
    const exchange = report.figures!.all.applications.find((a) => a.appDisplayName === 'Exchange Online')!
    const fromSnapshot = signIns.filter((s) => s.appDisplayName === 'Exchange Online')
    expect(exchange).toMatchObject({
      total: fromSnapshot.length,
      failed: fromSnapshot.filter((s) => s.errorCode !== 0).length,
    })
  })

  it('reads every error code with its count, adding up to the Failed tile (AC-3)', async () => {
    const report = (await asApiAfter(publishDay, (c) => read(c))) as StoredReport
    for (const scope of SCOPES) {
      const f = report.figures![scope]
      expect([...f.errorCodes].sort(byCode)).toEqual([...figures[scope].errorCodes].sort(byCode))
      expect(f.errorCodes.reduce((n, c) => n + c.failed, 0)).toBe(f.failed)
      expect(f.errorCodes).toHaveLength(f.errorCodeCount)
      const counts = f.errorCodes.map((c) => c.failed)
      expect(counts).toEqual([...counts].sort((a, b) => b - a))
    }
    const codes = report.figures!.all.errorCodes.map((c) => c.errorCode)
    expect(codes).toEqual(expect.arrayContaining([50126, 50053, 53003]))
    expect(report.figures!.all.errorCodes.find((c) => c.errorCode === 50126)?.failed).toBe(
      signIns.filter((s) => s.errorCode === 50126).length,
    )
  })

  it('reads each sign-in type on its own, the four adding up to All types (AC-4)', async () => {
    const report = (await asApiAfter(publishDay, (c) => read(c))) as StoredReport
    const types = SCOPES.filter((s) => s !== 'all').map((s) => report.figures![s])
    for (const key of ['total', 'successful', 'failed'] as const) {
      expect(types.reduce((n, f) => n + f[key], 0)).toBe(report.figures!.all[key])
    }
    expect(report.figures!.servicePrincipal.total).toBe(
      signIns.filter((s) => s.signInEventType === 'servicePrincipal').length,
    )
  })

  it('reads a type with no sign-ins as zeros and empty tables (AC-5)', async () => {
    const report = (await asApiAfter(publishDay, (c) => read(c))) as StoredReport
    expect(report.figures!.managedIdentity).toEqual({
      total: 0,
      successful: 0,
      failed: 0,
      errorCodeCount: 0,
      applications: [],
      errorCodes: [],
    })
  })

  it('reads nothing for a day whose report is not published yet (AC-6)', async () => {
    expect(await asApiAfter(publishDay, (c) => read(c, '2026-10-12'))).toBeNull()
  })

  it('reads a report published before figures were stored with no figures', async () => {
    const report = await asApiAfter(
      (c) => insertReport(c, DATE, signIns).then(() => undefined),
      (c) => read(c),
    )
    expect(report?.figures).toBeNull()
    expect(report?.totals.total).toBe(signIns.length)
  })

  it('reads the same figures on every view, exactly as stored, never from the snapshot (AC-10)', async () => {
    const [first, second, stored] = await asApiAfter(publishDay, async (c) => {
      const first = await read(c)
      const second = await read(c)
      const stored = await c.query(
        `SELECT sign_in_type, total, successful, failed, error_code_count FROM report_figures WHERE report_date = $1`,
        [DATE],
      )
      return [first, second, stored.rows] as const
    })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    for (const row of stored) {
      expect(first!.figures![row.sign_in_type as (typeof SCOPES)[number]]).toMatchObject({
        total: row.total,
        successful: row.successful,
        failed: row.failed,
        errorCodeCount: row.error_code_count,
      })
    }
  })

  it('does not read the snapshot evidence', async () => {
    const report = await asApiAfter(publishDay, (c) => read(c))
    expect(JSON.stringify(report)).not.toContain('createdDateTime')
    expect(report).not.toHaveProperty('snapshot')
  })

  it('reads a day that could not be generated, and nothing for one that was', async () => {
    const [missing, none] = await asApiAfter(
      async (c) => {
        await c.query(
          `INSERT INTO report_not_generated (report_date, missing_sources, recorded_at)
           VALUES ('2026-10-05', ARRAY['identityProtection.riskDetections'], '2026-10-06T07:00:00Z')`,
        )
      },
      async (c) => {
        const reader = createReportReader(connect(c))
        return [await reader.findNotGenerated('2026-10-05'), await reader.findNotGenerated('2026-10-06')] as const
      },
    )
    expect(missing).toEqual({
      reportDate: '2026-10-05',
      missingSources: ['identityProtection.riskDetections'],
      recordedAt: '2026-10-06T07:00:00.000Z',
    })
    expect(none).toBeNull()
  })

  it('surfaces the driver error without the bound values when the store fails (AC-8)', async () => {
    const client = await pool.connect()
    try {
      const error = await createReportReader(connect(client))
        .findPublished('not-a-date')
        .then(
          () => null,
          (e: unknown) => e as { code?: string; message: string },
        )
      expect(error?.code).toBe('22007')
      expect(error?.message).not.toContain('select')
    } finally {
      client.release()
    }
  })
})
