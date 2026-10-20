import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, migratedPool, noDatabase, sqlState } from './db.js'
import {
  daySignIns,
  figuresOf,
  insertApplication,
  insertErrorCode,
  insertFigures,
  insertReport,
  insertScope,
  reconcileState,
  SCOPES,
  type Figures,
} from './report-fixture.js'

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'
const FOREIGN_KEY_VIOLATION = '23503'
const UNIQUE_VIOLATION = '23505'
const RAISE_EXCEPTION = 'P0001'

const DATE = '2026-10-11'
const FIGURE_TABLES = ['report_figures', 'report_application_figures', 'report_error_code_figures']

const clone = (f: Figures): Figures => structuredClone(f)

describe.skipIf(noDatabase)('stored report figures (ST-3)', () => {
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

  /* Publishes the report with the given figures as the report worker and resolves to the reconciliation outcome. */
  const publish = (f: Figures) =>
    asRole(pool, 'sr_report_worker', async (c) => {
      await insertReport(c, DATE, signIns)
      await insertFigures(c, DATE, f)
      return reconcileState(c)
    })

  describe('publishing the figures with the report (AC-1 to AC-5)', () => {
    it('the report worker stores figures that reconcile to the report and the snapshot of the story day', async () => {
      /* 33 applications, the named error codes, and no managed identity sign-ins. */
      expect(figures.all.applications.map((a) => a.appDisplayName)).toEqual(
        expect.arrayContaining(['Exchange Online', 'Workday']),
      )
      expect(figures.all.applications).toHaveLength(33)
      expect(figures.all.errorCodes.map((c) => c.errorCode)).toEqual(expect.arrayContaining([50126, 50053, 53003]))
      expect(figures.managedIdentity.total).toBe(0)
      expect(await publish(figures)).toBeNull()
    })

    it('stores a type with no sign-ins as zeros with no rows (AC-5)', async () => {
      await asRole(pool, 'sr_report_worker', async (c) => {
        await insertReport(c, DATE, signIns)
        await insertFigures(c, DATE, figures)
        expect(await reconcileState(c)).toBeNull()
        const { rows } = await c.query(
          `SELECT total, successful, failed, error_code_count,
                  (SELECT count(*)::int FROM report_application_figures a
                    WHERE a.report_date = f.report_date AND a.sign_in_type = f.sign_in_type) AS apps,
                  (SELECT count(*)::int FROM report_error_code_figures e
                    WHERE e.report_date = f.report_date AND e.sign_in_type = f.sign_in_type) AS codes
             FROM report_figures f WHERE report_date = $1 AND sign_in_type = 'managedIdentity'`,
          [DATE],
        )
        expect(rows).toEqual([{ total: 0, successful: 0, failed: 0, error_code_count: 0, apps: 0, codes: 0 }])
      })
    })

    it('stores figures for a day with no sign-ins at all', async () => {
      const empty = figuresOf([])
      const state = await asRole(pool, 'sr_report_worker', async (c) => {
        await insertReport(c, '2026-10-04', [])
        await insertFigures(c, '2026-10-04', empty)
        return reconcileState(c)
      })
      expect(state).toBeNull()
    })

    it('rejects figures for a report that was never published', async () => {
      const state = await asRole(pool, 'sr_report_worker', (c) =>
        sqlState(() => insertScope(c, '2026-10-01', 'all', figures.all)),
      )
      expect(state).toBe(FOREIGN_KEY_VIOLATION)
    })

    it('rejects an application or error code row for a sign-in type that has no figures', async () => {
      for (const insert of [
        (c: pg.PoolClient) => insertApplication(c, DATE, 'all', figures.all.applications[0]!),
        (c: pg.PoolClient) => insertErrorCode(c, DATE, 'all', figures.all.errorCodes[0]!),
      ]) {
        const state = await asRole(pool, 'sr_report_worker', async (c) => {
          await insertReport(c, DATE, signIns)
          return sqlState(() => insert(c))
        })
        expect(state).toBe(FOREIGN_KEY_VIOLATION)
      }
    })

    it('stores each sign-in type, application and error code once', async () => {
      for (const insert of [
        (c: pg.PoolClient) => insertScope(c, DATE, 'all', figures.all),
        (c: pg.PoolClient) => insertApplication(c, DATE, 'all', figures.all.applications[0]!),
        (c: pg.PoolClient) => insertErrorCode(c, DATE, 'all', figures.all.errorCodes[0]!),
      ]) {
        const state = await asRole(pool, 'sr_report_worker', async (c) => {
          await insertReport(c, DATE, signIns)
          await insertFigures(c, DATE, figures)
          return sqlState(() => insert(c))
        })
        expect(state).toBe(UNIQUE_VIOLATION)
      }
    })
  })

  describe('row checks', () => {
    const rowState = (insert: (c: pg.PoolClient) => Promise<unknown>) =>
      asRole(pool, owner, async (c) => {
        await insertReport(c, DATE, signIns)
        await insertScope(c, DATE, 'all', figures.all)
        return sqlState(() => insert(c))
      })

    it('rejects an unknown sign-in type', async () => {
      expect(
        await asRole(pool, owner, async (c) => {
          await insertReport(c, DATE, signIns)
          return sqlState(() => insertScope(c, DATE, 'workloadIdentity', figures.all))
        }),
      ).toBe(CHECK_VIOLATION)
    })

    it('rejects tiles whose total is not successful plus failed, negative counts, or more codes than failures', async () => {
      for (const f of [
        { total: 3, successful: 1, failed: 1, errorCodeCount: 1 },
        { total: 0, successful: 1, failed: -1, errorCodeCount: 0 },
        { total: 2, successful: 0, failed: 2, errorCodeCount: 3 },
        { total: 2, successful: 2, failed: 0, errorCodeCount: 1 },
        { total: 2, successful: 0, failed: 2, errorCodeCount: 0 },
      ]) {
        const state = await asRole(pool, owner, async (c) => {
          await insertReport(c, DATE, signIns)
          return sqlState(() => insertScope(c, DATE, 'interactiveUser', f))
        })
        expect(state).toBe(CHECK_VIOLATION)
      }
    })

    it('accepts failures carried by exactly as many codes as failures, and none with no failures', async () => {
      for (const f of [
        { total: 2, successful: 0, failed: 2, errorCodeCount: 2 },
        { total: 2, successful: 0, failed: 2, errorCodeCount: 1 },
        { total: 0, successful: 0, failed: 0, errorCodeCount: 0 },
      ]) {
        const state = await asRole(pool, owner, async (c) => {
          await insertReport(c, DATE, signIns)
          return sqlState(() => insertScope(c, DATE, 'interactiveUser', f))
        })
        expect(state).toBeNull()
      }
    })

    it('rejects an application row with no sign-ins, a broken total, or a negative count', async () => {
      const app = { appId: 'x', appDisplayName: 'X' }
      for (const a of [
        { ...app, total: 0, successful: 0, failed: 0 },
        { ...app, total: 2, successful: 1, failed: 0 },
        { ...app, total: 0, successful: 1, failed: -1 },
      ]) {
        expect(await rowState((c) => insertApplication(c, DATE, 'all', a))).toBe(CHECK_VIOLATION)
      }
      expect(
        await rowState((c) => insertApplication(c, DATE, 'all', { ...app, total: 1, successful: 0, failed: 1 })),
      ).toBeNull()
    })

    it('rejects error code 0, which is a success, and a code with no failures', async () => {
      expect(await rowState((c) => insertErrorCode(c, DATE, 'all', { errorCode: 0, failed: 1 }))).toBe(CHECK_VIOLATION)
      expect(await rowState((c) => insertErrorCode(c, DATE, 'all', { errorCode: 50126, failed: 0 }))).toBe(
        CHECK_VIOLATION,
      )
      expect(await rowState((c) => insertErrorCode(c, DATE, 'all', { errorCode: 50126, failed: 1 }))).toBeNull()
      expect(await rowState((c) => insertErrorCode(c, DATE, 'all', { errorCode: -1, failed: 1 }))).toBeNull()
    })
  })

  describe('the stored figures reconcile when the transaction commits', () => {
    it('rejects All types tiles that differ from the report row by one (AC-1)', async () => {
      for (const key of ['successful', 'failed'] as const) {
        const f = clone(figures)
        f.all[key] -= 1
        f.all.total = f.all.successful + f.all.failed
        expect(await publish(f)).toBe(CHECK_VIOLATION)
      }
    })

    it('rejects a sign-in type whose figures are missing (AC-4, AC-5)', async () => {
      for (const missing of SCOPES) {
        const state = await asRole(pool, 'sr_report_worker', async (c) => {
          await insertReport(c, DATE, signIns)
          for (const scope of SCOPES.filter((s) => s !== missing)) {
            const f = figures[scope]
            await insertScope(c, DATE, scope, f)
            for (const a of f.applications) await insertApplication(c, DATE, scope, a)
            for (const e of f.errorCodes) await insertErrorCode(c, DATE, scope, e)
          }
          return reconcileState(c)
        })
        expect(state).toBe(CHECK_VIOLATION)
      }
    })

    it('rejects four types that do not add up to All types (AC-4)', async () => {
      const f = clone(figures)
      /* One more interactive success, carried by its application: the type adds up on its own, All types does not. */
      f.interactiveUser.successful += 1
      f.interactiveUser.total += 1
      f.interactiveUser.applications[0]!.successful += 1
      f.interactiveUser.applications[0]!.total += 1
      expect(await publish(f)).toBe(CHECK_VIOLATION)
    })

    it('rejects application rows that do not add up to their tiles (AC-2)', async () => {
      for (const key of ['successful', 'failed'] as const) {
        const f = clone(figures)
        const app = f.servicePrincipal.applications.find((a) => a[key] > 0)!
        app[key] += 1
        app.total += 1
        expect(await publish(f)).toBe(CHECK_VIOLATION)
      }
    })

    it('rejects an application whose rows across the four types differ from its All types row (AC-2, AC-4)', async () => {
      const f = clone(figures)
      const [a, b] = f.all.applications
      /* Swap one sign-in between two applications in All types only: every total still adds up. */
      const from = a!.successful > 0 ? a! : b!
      const to = from === a ? b! : a!
      from.successful -= 1
      from.total -= 1
      to.successful += 1
      to.total += 1
      expect(await publish(f)).toBe(CHECK_VIOLATION)
    })

    it('rejects error code counts that do not add up to the Failed tile (AC-3)', async () => {
      const f = clone(figures)
      f.interactiveUser.errorCodes[0]!.failed += 1
      expect(await publish(f)).toBe(CHECK_VIOLATION)
    })

    it('rejects an error code count that is not the number of codes listed (AC-1)', async () => {
      const f = clone(figures)
      const code = f.all.errorCodes.pop()!
      f.all.errorCodes[0]!.failed += code.failed
      expect(await publish(f)).toBe(CHECK_VIOLATION)
    })

    it('rejects an error code whose counts across the four types differ from All types (AC-3, AC-4)', async () => {
      const f = clone(figures)
      const [a, b] = f.all.errorCodes
      a!.failed += 1
      b!.failed -= 1
      if (b!.failed === 0) {
        f.all.errorCodes.splice(1, 1)
        f.all.errorCodeCount -= 1
      }
      expect(await publish(f)).toBe(CHECK_VIOLATION)
    })
  })

  describe('the stored figures never change (AC-10)', () => {
    it('rejects every UPDATE of stored figures, even by the owner', async () => {
      for (const statement of [
        `UPDATE report_figures SET total = total`,
        `UPDATE report_application_figures SET app_display_name = 'Renamed'`,
        `UPDATE report_error_code_figures SET failed = failed`,
      ]) {
        const state = await asRole(pool, owner, async (c) => {
          await insertReport(c, DATE, signIns)
          await insertFigures(c, DATE, figures)
          return sqlState(() => c.query(statement))
        })
        expect(state).toBe(RAISE_EXCEPTION)
      }
    })

    it('rejects TRUNCATE of stored figures', async () => {
      for (const table of FIGURE_TABLES) {
        expect(await asRole(pool, owner, (c) => sqlState(() => c.query(`TRUNCATE ${table} CASCADE`)))).toBe(
          RAISE_EXCEPTION,
        )
      }
    })

    it('figures cannot be added to a report after it was published', async () => {
      await asRole(pool, owner, async (c) => {
        await insertReport(c, DATE, signIns)
        await insertFigures(c, DATE, figures)
        expect(await reconcileState(c)).toBeNull()
        /* Once checked, as at commit, a later row is checked as it is written. */
        const late = { appId: 'late', appDisplayName: 'Late', total: 1, successful: 1, failed: 0 }
        expect(await sqlState(() => insertApplication(c, DATE, 'all', late))).toBe(CHECK_VIOLATION)
      })
    })

    it('purging a report removes its figures with it', async () => {
      await asRole(pool, owner, async (c) => {
        await insertReport(c, DATE, signIns)
        await insertFigures(c, DATE, figures)
        await c.query('DELETE FROM report WHERE report_date = $1', [DATE])
        for (const table of FIGURE_TABLES) {
          const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`)
          expect(rows[0].n).toBe(0)
        }
      })
    })
  })

  describe('per-role grants (AD-10)', () => {
    it('the report worker cannot alter or remove stored figures', async () => {
      for (const table of FIGURE_TABLES) {
        for (const statement of [
          `UPDATE ${table} SET report_date = report_date`,
          `DELETE FROM ${table}`,
          `TRUNCATE ${table}`,
        ]) {
          expect(await asRole(pool, 'sr_report_worker', (c) => sqlState(() => c.query(statement)))).toBe(
            INSUFFICIENT_PRIVILEGE,
          )
        }
      }
    })

    it('the API reads the figures but writes none', async () => {
      await asRole(pool, 'sr_api', async (c) => {
        for (const table of FIGURE_TABLES) await c.query(`SELECT * FROM ${table}`)
      })
      for (const insert of [
        (c: pg.PoolClient) => insertScope(c, DATE, 'all', figures.all),
        (c: pg.PoolClient) => insertApplication(c, DATE, 'all', figures.all.applications[0]!),
        (c: pg.PoolClient) => insertErrorCode(c, DATE, 'all', figures.all.errorCodes[0]!),
      ]) {
        expect(await asRole(pool, 'sr_api', (c) => sqlState(() => insert(c)))).toBe(INSUFFICIENT_PRIVILEGE)
      }
      for (const table of FIGURE_TABLES) {
        expect(await asRole(pool, 'sr_api', (c) => sqlState(() => c.query(`DELETE FROM ${table}`)))).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      }
    })

    it('the mail worker cannot read the per-application or per-code figures', async () => {
      for (const table of FIGURE_TABLES) {
        expect(await asRole(pool, 'sr_mail_worker', (c) => sqlState(() => c.query(`SELECT * FROM ${table}`)))).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      }
    })

    it('grants nothing to PUBLIC', async () => {
      const { rows } = await pool.query(
        `SELECT c.relname AS table, bool_or(a.grantee = 0) AS public
           FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.relname = ANY($1) AND c.relnamespace = 'public'::regnamespace
          GROUP BY c.relname ORDER BY c.relname`,
        [FIGURE_TABLES],
      )
      expect(rows).toEqual([...FIGURE_TABLES].sort().map((table) => ({ table, public: false })))
    })
  })
})
