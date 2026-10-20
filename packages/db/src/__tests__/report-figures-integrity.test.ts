import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect } from '../client.js'
import { createReportReader } from '../report-reader.js'
import { asRole, migratedPool, noDatabase } from './db.js'
import { daySignIns, figuresOf, insertFigures, insertReport, reconcileState } from './report-fixture.js'

const CHECK_VIOLATION = '23514'
const DATE = '2026-10-11'

/* The SQLSTATE and message a deferred check fails with, or null when the figures reconcile. */
async function reconcileFailure(client: pg.PoolClient): Promise<{ code: string; message: string } | null> {
  try {
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    return null
  } catch (error) {
    const { code, message } = error as { code: string; message: string }
    return { code, message }
  }
}

describe.skipIf(noDatabase)('stored report figures stay whole (ST-3, AC-10)', () => {
  let pool: pg.Pool
  let owner: string
  const signIns = daySignIns(DATE)
  const figures = figuresOf(signIns)

  beforeAll(async () => {
    pool = await migratedPool()
    owner = (await pool.query('SELECT current_user AS u')).rows[0].u
  })
  afterAll(async () => {
    await pool?.end()
  })

  const asOwner = <T>(fn: (c: pg.PoolClient) => Promise<T>) => asRole(pool, owner, fn)

  it('rejects All types figures that agree with each other but not with the published totals (AC-1)', async () => {
    /* The figures come from a day where one success failed instead: every figure adds up, the report does not. */
    const flipped = signIns.map((s, i) => (i === 0 ? { ...s, errorCode: 50126 } : s))
    const failure = await asRole(pool, 'sr_report_worker', async (c) => {
      await insertReport(c, DATE, signIns)
      await insertFigures(c, DATE, figuresOf(flipped))
      return reconcileFailure(c)
    })
    expect(failure).toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(/published totals/) })
  })

  it('rejects an application named differently in one sign-in type than in All types (AC-2)', async () => {
    const f = structuredClone(figures)
    f.interactiveUser.applications[0]!.appDisplayName = 'Renamed'
    const failure = await asRole(pool, 'sr_report_worker', async (c) => {
      await insertReport(c, DATE, signIns)
      await insertFigures(c, DATE, f)
      return reconcileFailure(c)
    })
    expect(failure).toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(/named/) })
  })

  it('rejects deleting stored figure rows, even by the owner', async () => {
    for (const statement of [
      `DELETE FROM report_application_figures WHERE ctid = (SELECT min(ctid) FROM report_application_figures)`,
      `DELETE FROM report_error_code_figures WHERE ctid = (SELECT min(ctid) FROM report_error_code_figures)`,
      `DELETE FROM report_figures WHERE sign_in_type = 'servicePrincipal'`,
      `DELETE FROM report_figures`,
    ]) {
      const state = await asOwner(async (c) => {
        await insertReport(c, DATE, signIns)
        await insertFigures(c, DATE, figures)
        expect(await reconcileState(c)).toBeNull()
        await c.query('SET CONSTRAINTS ALL DEFERRED')
        await c.query(statement)
        return reconcileState(c)
      })
      expect(state).toBe(CHECK_VIOLATION)
    }
  })

  it('purging a published report with its figures passes the commit-time check', async () => {
    const state = await asOwner(async (c) => {
      await insertReport(c, DATE, signIns)
      await insertFigures(c, DATE, figures)
      await c.query('DELETE FROM report WHERE report_date = $1', [DATE])
      return reconcileState(c)
    })
    expect(state).toBeNull()
  })

  describe('figures are written only in the transaction that publishes the report', () => {
    const LATER = '2026-09-01'

    afterAll(async () => {
      await pool?.query('DELETE FROM report WHERE report_date = $1', [LATER])
    })

    it('rejects figures added to a report published by an earlier transaction', async () => {
      const day = daySignIns(LATER)
      const client = await pool.connect()
      try {
        await client.query('SET ROLE sr_report_worker')
        await insertReport(client, LATER, day)
        await client.query('BEGIN')
        const failure = await insertFigures(client, LATER, figuresOf(day)).then(
          () => null,
          (error: { code: string }) => error.code,
        )
        await client.query('ROLLBACK')
        expect(failure).toBe(CHECK_VIOLATION)
      } finally {
        await client.query('RESET ROLE')
        client.release()
      }
    })
  })

  it('reads the stored figures even where the snapshot would give others (AC-10)', async () => {
    /* Same counts, other applications and codes in the snapshot: a reader that recomputed would differ. */
    const relabelled = signIns.map((s) => ({
      ...s,
      appId: 'snapshot-app',
      appDisplayName: 'Snapshot app',
      errorCode: s.errorCode === 0 ? 0 : 99999,
    }))
    const report = await asRole(pool, 'sr_report_worker', async (c) => {
      await insertReport(c, DATE, relabelled)
      await insertFigures(c, DATE, figures)
      expect(await reconcileState(c)).toBeNull()
      await c.query('RESET ROLE')
      await c.query('SET LOCAL ROLE sr_api')
      return createReportReader(connect(c)).findPublished(DATE)
    })
    expect(report!.figures!.all.applications).toHaveLength(33)
    expect(report!.figures!.all.applications.map((a) => a.appDisplayName)).not.toContain('Snapshot app')
    expect(report!.figures!.all.errorCodes.map((e) => e.errorCode)).not.toContain(99999)
  })

  it('orders tied applications by application ID, independent of collation (AC-2)', async () => {
    const report = await asRole(pool, 'sr_report_worker', async (c) => {
      await insertReport(c, DATE, signIns)
      await insertFigures(c, DATE, figures)
      return createReportReader(connect(c)).findPublished(DATE)
    })
    const apps = report!.figures!.all.applications
    const expected = [...apps].sort((a, b) => b.total - a.total || (a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0))
    expect(apps.map((a) => a.appId)).toEqual(expected.map((a) => a.appId))
  })
})
