import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, migratedPool, noDatabase, sqlState } from './db.js'

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'
const FOREIGN_KEY_VIOLATION = '23503'
const RAISE_EXCEPTION = 'P0001'
const FEATURE_NOT_SUPPORTED = '0A000'

const DATE = '2026-10-11'

interface ReportRow {
  status: string
  missing_sources: string[]
  risky_sign_ins: number | null
  risky_users: number | null
  snapshot: Record<string, unknown>
}

const detection = (id: string, riskLevel = 'high') => ({
  id,
  riskEventType: 'unfamiliarFeatures',
  riskLevel,
  detectedDateTime: '2026-10-11T08:15:00.000Z',
})

const riskyUser = (id: string, riskState = 'atRisk', riskLevel = 'high') => ({
  id,
  userPrincipalName: `${id}@contoso.example`,
  riskState,
  riskLevel,
})

const report = (overrides: Partial<ReportRow> = {}): ReportRow => ({
  status: 'complete',
  missing_sources: [],
  risky_sign_ins: 0,
  risky_users: 0,
  snapshot: { signIns: [], riskDetections: [], riskyUsers: [] },
  ...overrides,
})

/* The report worker's publish: one row per date, written once. The risk counts are NULL when not evaluated. */
const insertReport = (client: pg.PoolClient, r: ReportRow = report()) =>
  client.query(
    `INSERT INTO report (report_date, window_start, window_end, status, missing_sources, total, successful, failed,
                         risky_sign_ins, risky_users, snapshot, content_hash, published_at)
     VALUES ($1::date, '2026-10-11T00:00:00Z', '2026-10-12T00:00:00Z', $2, $3::text[], 0, 0, 0,
             $4, $5, $6::jsonb, $7, '2026-10-12T02:00:00Z')
     ON CONFLICT (report_date) DO NOTHING`,
    [DATE, r.status, r.missing_sources, r.risky_sign_ins, r.risky_users, JSON.stringify(r.snapshot), 'a'.repeat(64)],
  )

interface SignInFlag {
  request_id: string
  trigger_level: string
  observed_risk_level: string
  signed_in_at: string
  user_id: string | null
  user_principal_name: string | null
  app_id: string | null
  app_display_name: string | null
  ip_address: string | null
  location: string | null
  device_compliant: boolean | null
  conditional_access_status: string | null
}

const signInFlag = (overrides: Partial<SignInFlag> = {}): SignInFlag => ({
  request_id: 'b7f1c2d4-0000-4000-8000-000000000001',
  trigger_level: 'medium',
  observed_risk_level: 'high',
  signed_in_at: '2026-10-11T09:30:00.000Z',
  user_id: '6a1f0c3e-1111-4111-8111-111111111111',
  user_principal_name: 'd.chen@contoso.example',
  app_id: '00000002-0000-0ff1-ce00-000000000000',
  app_display_name: 'Exchange Online',
  ip_address: '203.0.113.7',
  location: 'Lisbon, Lisboa, PT',
  device_compliant: false,
  conditional_access_status: 'success',
  ...overrides,
})

const SIGN_IN_COLUMNS = Object.keys(signInFlag())

const insertSignInFlag = (client: pg.PoolClient, f: SignInFlag = signInFlag()) =>
  client.query(
    `INSERT INTO report_risky_sign_in_flag (report_date, ${SIGN_IN_COLUMNS.join(', ')})
     VALUES ($1::date, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10::inet, $11, $12, $13)
     ON CONFLICT (report_date, request_id) DO NOTHING`,
    [DATE, ...SIGN_IN_COLUMNS.map((k) => f[k as keyof SignInFlag])],
  )

interface UserFlag {
  user_id: string
  user_principal_name: string | null
  user_display_name: string | null
  trigger_level: string
  risk_state: string
  risk_level: string
  detections: unknown
  sign_in_ids: (string | null)[]
}

const userFlag = (overrides: Partial<UserFlag> = {}): UserFlag => ({
  user_id: '9c2e7a10-2222-4222-8222-222222222222',
  user_principal_name: 'j.morales@contoso.example',
  user_display_name: 'J. Morales',
  trigger_level: 'medium',
  risk_state: 'atRisk',
  risk_level: 'high',
  detections: [detection('det-1'), { ...detection('det-2', 'medium'), riskEventType: 'anonymizedIPAddress' }],
  sign_in_ids: ['si-1', 'si-2', 'si-3', 'si-4'],
  ...overrides,
})

const insertUserFlag = (client: pg.PoolClient, f: UserFlag = userFlag()) =>
  client.query(
    `INSERT INTO report_risky_user_flag (report_date, user_id, user_principal_name, user_display_name, trigger_level,
                                         risk_state, risk_level, detections, sign_in_ids)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text[])
     ON CONFLICT (report_date, user_id) DO NOTHING`,
    [
      DATE,
      f.user_id,
      f.user_principal_name,
      f.user_display_name,
      f.trigger_level,
      f.risk_state,
      f.risk_level,
      JSON.stringify(f.detections),
      f.sign_in_ids,
    ],
  )

/* The reconciliation of the counts to the flags is deferred to commit; this runs it now, inside the test's
 * rolled-back transaction. */
const settle = (client: pg.PoolClient) => client.query('SET CONSTRAINTS ALL IMMEDIATE')

describe.skipIf(noDatabase)('risky sign-in and risky user flags (ST-9)', () => {
  let pool: pg.Pool
  let owner: string

  beforeAll(async () => {
    pool = await migratedPool()
    owner = (await pool.query('SELECT current_user AS u')).rows[0].u
  })
  afterAll(async () => {
    await pool?.end()
  })

  const asOwner = <T>(fn: (client: pg.PoolClient) => Promise<T>) => asRole(pool, owner, fn)
  const reportState = (r: ReportRow) => asOwner((c) => sqlState(() => insertReport(c, r)))
  /* Publishes a report counting one risky sign-in (or one risky user) and the one flag, then settles. */
  const signInState = (f: SignInFlag) =>
    asOwner(async (c) => {
      await insertReport(c, report({ risky_sign_ins: 1 }))
      return sqlState(async () => {
        await insertSignInFlag(c, f)
        await settle(c)
      })
    })
  const userState = (f: UserFlag) =>
    asOwner(async (c) => {
      await insertReport(c, report({ risky_users: 1 }))
      return sqlState(async () => {
        await insertUserFlag(c, f)
        await settle(c)
      })
    })

  describe('risk data in the snapshot (AC-1)', () => {
    it('holds the 6 risk detections and the 3 risky users exactly as collected', async () => {
      const snapshot = {
        signIns: [],
        riskDetections: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((id) => detection(id)),
        riskyUsers: [riskyUser('u1'), riskyUser('u2', 'remediated'), riskyUser('u3', 'atRisk', 'low')],
      }
      await asRole(pool, 'sr_report_worker', async (c) => {
        await insertReport(c, report({ snapshot }))
        await settle(c)
        const { rows } = await c.query(`SELECT snapshot FROM report WHERE report_date = $1`, [DATE])
        expect(rows[0].snapshot).toEqual(snapshot)
        expect(rows[0].snapshot.riskDetections).toHaveLength(6)
        expect(rows[0].snapshot.riskyUsers).toHaveLength(3)
      })
    })

    it('rejects evaluated risk counts whose snapshot lacks the risk detections or the risky users', async () => {
      for (const snapshot of [
        { signIns: [], riskDetections: [] },
        { signIns: [], riskyUsers: [] },
        { signIns: [], riskDetections: [], riskyUsers: {} },
      ]) {
        expect(await reportState(report({ snapshot }))).toBe(CHECK_VIOLATION)
      }
    })

    it('a report from before ST-9, with no risk counts, is still accepted', async () => {
      expect(
        await reportState(report({ risky_sign_ins: null, risky_users: null, snapshot: { signIns: [] } })),
      ).toBeNull()
    })
  })

  describe('risky sign-in trigger and its boundary (AC-2)', () => {
    it('raises a flag at observed high and at medium, the trigger level', async () => {
      expect(await signInState(signInFlag({ observed_risk_level: 'high' }))).toBeNull()
      expect(await signInState(signInFlag({ observed_risk_level: 'medium' }))).toBeNull()
    })

    it('raises none at low, one below the trigger, at none, or at a level Graph did not define', async () => {
      for (const observed_risk_level of ['low', 'none', 'hidden', 'unknownFutureValue']) {
        expect(await signInState(signInFlag({ observed_risk_level }))).toBe(CHECK_VIOLATION)
      }
    })

    it('stores the trigger it was raised against and rejects an unknown trigger level', async () => {
      expect(await signInState(signInFlag({ trigger_level: 'high', observed_risk_level: 'high' }))).toBeNull()
      expect(await signInState(signInFlag({ trigger_level: 'high', observed_risk_level: 'medium' }))).toBe(
        CHECK_VIOLATION,
      )
      for (const trigger_level of ['none', 'low']) {
        expect(await signInState(signInFlag({ trigger_level, observed_risk_level: 'high' }))).toBe(CHECK_VIOLATION)
      }
      expect(await signInState(signInFlag({ trigger_level: 'low', observed_risk_level: 'low' }))).toBe(CHECK_VIOLATION)
    })

    it('accepts a sign-in from 00:00:00.000Z up to 23:59:59.999Z of the day and none outside it', async () => {
      for (const signed_in_at of ['2026-10-11T00:00:00.000Z', '2026-10-11T23:59:59.999Z']) {
        expect(await signInState(signInFlag({ signed_in_at }))).toBeNull()
      }
      for (const signed_in_at of ['2026-10-10T23:59:59.999Z', '2026-10-12T00:00:00.000Z']) {
        expect(await signInState(signInFlag({ signed_in_at }))).toBe(CHECK_VIOLATION)
      }
    })
  })

  describe('risky user trigger and its boundary (AC-3)', () => {
    it('raises a flag for atRisk at high and confirmedCompromised at medium', async () => {
      expect(await userState(userFlag({ risk_state: 'atRisk', risk_level: 'high' }))).toBeNull()
      expect(await userState(userFlag({ risk_state: 'confirmedCompromised', risk_level: 'medium' }))).toBeNull()
    })

    it('raises none at low, or for remediated, dismissed or none', async () => {
      for (const [risk_state, risk_level] of [
        ['atRisk', 'low'],
        ['remediated', 'high'],
        ['dismissed', 'high'],
        ['none', 'none'],
        ['atRisk', 'none'],
      ]) {
        expect(await userState(userFlag({ risk_state: risk_state!, risk_level: risk_level! }))).toBe(CHECK_VIOLATION)
      }
    })

    it('rejects a level below a stored high trigger and an unknown trigger level', async () => {
      expect(await userState(userFlag({ trigger_level: 'high', risk_level: 'medium' }))).toBe(CHECK_VIOLATION)
      expect(await userState(userFlag({ trigger_level: 'severe' }))).toBe(CHECK_VIOLATION)
      expect(await userState(userFlag({ trigger_level: 'low', risk_level: 'low' }))).toBe(CHECK_VIOLATION)
    })
  })

  describe('a risky sign-in flag carries its evidence (AC-4)', () => {
    it('reads back trigger medium against observed high with every evidence field as written', async () => {
      await asRole(pool, 'sr_report_worker', async (c) => {
        await insertReport(c, report({ risky_sign_ins: 1 }))
        await insertSignInFlag(c)
        await settle(c)
        const { rows } = await c.query(
          `SELECT ${SIGN_IN_COLUMNS.map((k) => (k === 'ip_address' ? 'host(ip_address) AS ip_address' : k)).join(', ')}
             FROM report_risky_sign_in_flag WHERE report_date = $1`,
          [DATE],
        )
        expect(rows).toEqual([{ ...signInFlag(), signed_in_at: new Date('2026-10-11T09:30:00.000Z') }])
      })
    })

    it('stores an IPv6 address and rejects a value that is not an IP address', async () => {
      expect(await signInState(signInFlag({ ip_address: '2001:db8::7' }))).toBeNull()
      expect(await signInState(signInFlag({ ip_address: 'not-an-ip' }))).toBe('22P02')
    })

    it('rejects an unknown Conditional Access result and a blank request ID', async () => {
      expect(await signInState(signInFlag({ conditional_access_status: 'blocked' }))).toBe(CHECK_VIOLATION)
      for (const request_id of ['', '  ', '\t', '\n']) {
        expect(await signInState(signInFlag({ request_id }))).toBe(CHECK_VIOLATION)
      }
    })

    it('a flag needs its published report', async () => {
      expect(await asOwner((c) => sqlState(() => insertSignInFlag(c)))).toBe(FOREIGN_KEY_VIOLATION)
      expect(await asOwner((c) => sqlState(() => insertUserFlag(c)))).toBe(FOREIGN_KEY_VIOLATION)
    })
  })

  describe('a risky user flag carries its detections and linked sign-ins (AC-5)', () => {
    it('reads back atRisk at high, both detections and the IDs of the 4 sign-ins', async () => {
      await asRole(pool, 'sr_report_worker', async (c) => {
        await insertReport(c, report({ risky_users: 1 }))
        await insertUserFlag(c)
        await settle(c)
        const { rows } = await c.query(
          `SELECT user_id, user_principal_name, user_display_name, trigger_level, risk_state, risk_level,
                  detections, sign_in_ids
             FROM report_risky_user_flag WHERE report_date = $1`,
          [DATE],
        )
        expect(rows).toEqual([userFlag()])
        expect(rows[0].detections).toHaveLength(2)
        expect(rows[0].sign_in_ids).toHaveLength(4)
      })
    })

    it('accepts a user with no contributing detection or sign-in in the window', async () => {
      expect(await userState(userFlag({ detections: [], sign_in_ids: [] }))).toBeNull()
    })

    it('rejects detections that are not a list of ID, type, risk level and timestamp', async () => {
      const untyped: Record<string, unknown> = { ...detection('det-3') }
      delete untyped['riskEventType']
      for (const detections of [
        {},
        'det-1',
        [untyped],
        [{ ...detection('det-3'), id: 3 }],
        [{ ...detection('det-3'), detectedDateTime: null }],
        ['det-3'],
        [[detection('det-3')]],
        [{ ...detection('det-3'), id: ' ' }],
        [{ ...detection('det-3'), riskEventType: '' }],
        [{ ...detection('det-3'), riskLevel: 'banana' }],
        [{ ...detection('det-3'), detectedDateTime: 'yesterday' }],
      ]) {
        expect(await userState(userFlag({ detections }))).toBe(CHECK_VIOLATION)
      }
    })

    it('rejects a blank user ID and a missing or blank sign-in ID', async () => {
      expect(await userState(userFlag({ user_id: ' ' }))).toBe(CHECK_VIOLATION)
      expect(await userState(userFlag({ sign_in_ids: ['si-1', null] }))).toBe(CHECK_VIOLATION)
      for (const blank of ['', ' ', '\t']) {
        expect(await userState(userFlag({ sign_in_ids: ['si-1', blank] }))).toBe(CHECK_VIOLATION)
      }
    })
  })

  describe('a blank field from Entra does not suppress the flag (AC-6)', () => {
    it('raises a high-risk sign-in flag with no location, storing it as not recorded', async () => {
      await asOwner(async (c) => {
        await insertReport(c, report({ risky_sign_ins: 1 }))
        await insertSignInFlag(c, signInFlag({ location: null }))
        await settle(c)
        const { rows } = await c.query(`SELECT location FROM report_risky_sign_in_flag`)
        expect(rows).toEqual([{ location: null }])
      })
    })

    it('raises a flag with every optional evidence field not recorded', async () => {
      const blank = {
        user_id: null,
        user_principal_name: null,
        app_id: null,
        app_display_name: null,
        ip_address: null,
        location: null,
        device_compliant: null,
        conditional_access_status: null,
      }
      expect(await signInState(signInFlag(blank))).toBeNull()
      expect(await userState(userFlag({ user_principal_name: null, user_display_name: null }))).toBeNull()
    })

    it('rejects a blank string, so not recorded has one form', async () => {
      for (const field of ['user_id', 'user_principal_name', 'app_id', 'app_display_name', 'location'] as const) {
        expect(await signInState(signInFlag({ [field]: ' ' }))).toBe(CHECK_VIOLATION)
      }
      for (const field of ['user_principal_name', 'user_display_name'] as const) {
        expect(await userState(userFlag({ [field]: '' }))).toBe(CHECK_VIOLATION)
      }
    })
  })

  describe('Identity Protection could not be read (AC-7)', () => {
    const missing = (...sources: string[]) => ({ status: 'incomplete', missing_sources: sources })

    it('accepts an incomplete report naming either Identity Protection source with both categories not evaluated', async () => {
      for (const sources of [
        ['identityProtection.riskDetections', 'identityProtection.riskyUsers'],
        ['identityProtection.riskyUsers'],
        ['identityProtection.riskDetections'],
      ]) {
        expect(
          await reportState(report({ ...missing(...sources), risky_sign_ins: null, risky_users: null })),
        ).toBeNull()
      }
    })

    it('rejects a quiet zero, or any count, for a category that could not be evaluated', async () => {
      for (const counts of [
        { risky_sign_ins: 0, risky_users: 0 },
        { risky_sign_ins: 0, risky_users: null },
        { risky_sign_ins: null, risky_users: 0 },
        { risky_sign_ins: 2, risky_users: 1 },
      ]) {
        expect(await reportState(report({ ...missing('identityProtection.riskyUsers'), ...counts }))).toBe(
          CHECK_VIOLATION,
        )
      }
    })

    it('rejects one category evaluated without the other, and a negative count', async () => {
      for (const counts of [
        { risky_sign_ins: 0, risky_users: null },
        { risky_sign_ins: null, risky_users: 0 },
        { risky_sign_ins: -1, risky_users: 0 },
        { risky_sign_ins: 0, risky_users: -1 },
      ]) {
        expect(await reportState(report(counts))).toBe(CHECK_VIOLATION)
      }
    })

    it('still evaluates the risk categories when only a sign-in source is missing', async () => {
      expect(await reportState(report(missing('signIns.servicePrincipal')))).toBeNull()
    })

    it('rejects a flag on a report whose risk categories were not evaluated', async () => {
      const state = await asOwner(async (c) => {
        await insertReport(
          c,
          report({ ...missing('identityProtection.riskDetections'), risky_sign_ins: null, risky_users: null }),
        )
        return sqlState(async () => {
          await insertSignInFlag(c)
          await settle(c)
        })
      })
      expect(state).toBe(CHECK_VIOLATION)
    })

    it('records a not-generated day naming the risky users source', async () => {
      await asRole(pool, 'sr_report_worker', (c) =>
        c.query(
          `INSERT INTO report_not_generated (report_date, missing_sources, recorded_at)
           VALUES ('2026-10-05', ARRAY['identityProtection.riskyUsers'], '2026-10-06T07:00:00Z')`,
        ),
      )
    })
  })

  describe('the counts reconcile to the stored flags', () => {
    it('accepts counts equal to the flag rows', async () => {
      await asOwner(async (c) => {
        await insertReport(c, report({ risky_sign_ins: 2, risky_users: 1 }))
        await insertSignInFlag(c)
        await insertSignInFlag(c, signInFlag({ request_id: 'second', observed_risk_level: 'medium' }))
        await insertUserFlag(c)
        await settle(c)
        const { rows } = await c.query(
          `SELECT r.risky_sign_ins, r.risky_users,
                  (SELECT count(*)::int FROM report_risky_sign_in_flag f WHERE f.report_date = r.report_date) AS s,
                  (SELECT count(*)::int FROM report_risky_user_flag f WHERE f.report_date = r.report_date) AS u
             FROM report r`,
        )
        expect(rows).toEqual([{ risky_sign_ins: 2, risky_users: 1, s: 2, u: 1 }])
      })
    })

    it('rejects a count above or below its flags at commit', async () => {
      for (const counts of [
        { risky_sign_ins: 2, risky_users: 0 },
        { risky_sign_ins: 0, risky_users: 0 },
        { risky_sign_ins: 1, risky_users: 1 },
      ]) {
        const state = await asOwner(async (c) => {
          await insertReport(c, report(counts))
          return sqlState(async () => {
            await insertSignInFlag(c)
            await settle(c)
          })
        })
        expect(state).toBe(CHECK_VIOLATION)
      }
    })

    it('rejects a report counting flags it never stored', async () => {
      const state = await asOwner(async (c) =>
        sqlState(async () => {
          await insertReport(c, report({ risky_sign_ins: 0, risky_users: 3 }))
          await settle(c)
        }),
      )
      expect(state).toBe(CHECK_VIOLATION)
    })

    it('rejects removing a flag while its report still counts it', async () => {
      const state = await asOwner(async (c) => {
        await insertReport(c, report({ risky_sign_ins: 1, risky_users: 1 }))
        await insertSignInFlag(c)
        await insertUserFlag(c)
        await settle(c)
        return sqlState(async () => {
          await c.query('DELETE FROM report_risky_user_flag')
          await settle(c)
        })
      })
      expect(state).toBe(CHECK_VIOLATION)
    })

    it('reconciles against the stored report even when a temporary table shadows its name', async () => {
      const state = await asRole(pool, 'sr_report_worker', async (c) => {
        await insertReport(c, report({ risky_sign_ins: 5, risky_users: 0 }))
        await c.query('CREATE TEMP TABLE report (LIKE public.report) ON COMMIT DROP')
        await c.query(`INSERT INTO pg_temp.report SELECT * FROM public.report`)
        await c.query(`UPDATE pg_temp.report SET risky_sign_ins = 1`)
        return sqlState(async () => {
          await insertSignInFlag(c)
          await settle(c)
        })
      })
      expect(state).toBe(CHECK_VIOLATION)
    })

    it('a purge of the report removes its flags with it', async () => {
      await asOwner(async (c) => {
        await insertReport(c, report({ risky_sign_ins: 1, risky_users: 1 }))
        await insertSignInFlag(c)
        await insertUserFlag(c)
        await settle(c)
        await c.query('DELETE FROM report')
        await settle(c)
        const { rows } = await c.query(
          `SELECT (SELECT count(*)::int FROM report_risky_sign_in_flag) AS s,
                  (SELECT count(*)::int FROM report_risky_user_flag) AS u`,
        )
        expect(rows[0]).toEqual({ s: 0, u: 0 })
      })
    })
  })

  describe('flags are written once (idempotent re-run, immutability)', () => {
    it('a re-run by the report worker leaves one report and one of each flag', async () => {
      await asRole(pool, 'sr_report_worker', async (c) => {
        for (let run = 0; run < 2; run += 1) {
          await insertReport(c, report({ risky_sign_ins: 1, risky_users: 1 }))
          await insertSignInFlag(c, signInFlag({ observed_risk_level: run === 0 ? 'high' : 'medium' }))
          await insertUserFlag(c)
          await settle(c)
        }
        const { rows } = await c.query(
          `SELECT (SELECT count(*)::int FROM report) AS r,
                  (SELECT observed_risk_level FROM report_risky_sign_in_flag) AS observed,
                  (SELECT count(*)::int FROM report_risky_user_flag) AS u`,
        )
        expect(rows[0]).toEqual({ r: 1, observed: 'high', u: 1 })
      })
    })

    it('rejects every UPDATE of a flag, even by the owner', async () => {
      for (const statement of [
        `UPDATE report_risky_sign_in_flag SET location = NULL`,
        `UPDATE report_risky_sign_in_flag SET observed_risk_level = observed_risk_level`,
        `UPDATE report_risky_user_flag SET risk_state = 'confirmedCompromised'`,
        `UPDATE report_risky_user_flag SET sign_in_ids = '{}'`,
      ]) {
        const state = await asOwner(async (c) => {
          await insertReport(c, report({ risky_sign_ins: 1, risky_users: 1 }))
          await insertSignInFlag(c)
          await insertUserFlag(c)
          return sqlState(() => c.query(statement))
        })
        expect(state).toBe(RAISE_EXCEPTION)
      }
    })

    it('refuses TRUNCATE of the reports, which their flags reference', async () => {
      expect(await asOwner((c) => sqlState(() => c.query('TRUNCATE report')))).toBe(FEATURE_NOT_SUPPORTED)
    })

    it('rejects TRUNCATE of either flag table', async () => {
      for (const table of ['report_risky_sign_in_flag', 'report_risky_user_flag']) {
        expect(await asOwner((c) => sqlState(() => c.query(`TRUNCATE ${table}`)))).toBe(RAISE_EXCEPTION)
      }
    })
  })

  describe('per-role grants (AD-10)', () => {
    const FLAG_TABLES = ['report_risky_sign_in_flag', 'report_risky_user_flag']

    it('the report worker cannot alter or remove a flag', async () => {
      for (const table of FLAG_TABLES) {
        for (const statement of [`UPDATE ${table} SET trigger_level = 'high'`, `DELETE FROM ${table}`]) {
          expect(await asRole(pool, 'sr_report_worker', (c) => sqlState(() => c.query(statement)))).toBe(
            INSUFFICIENT_PRIVILEGE,
          )
        }
      }
    })

    it('the API reads the flags but writes none', async () => {
      await asRole(pool, 'sr_api', async (c) => {
        for (const table of FLAG_TABLES) await c.query(`SELECT * FROM ${table}`)
        await c.query('SELECT risky_sign_ins, risky_users FROM report')
      })
      for (const insert of [insertSignInFlag, insertUserFlag]) {
        expect(await asRole(pool, 'sr_api', (c) => sqlState(() => insert(c)))).toBe(INSUFFICIENT_PRIVILEGE)
      }
      for (const table of FLAG_TABLES) {
        expect(await asRole(pool, 'sr_api', (c) => sqlState(() => c.query(`DELETE FROM ${table}`)))).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      }
    })

    it('the mail worker reads the risky counts but never a flag or its evidence', async () => {
      await asRole(pool, 'sr_mail_worker', (c) =>
        c.query('SELECT report_date, risky_sign_ins, risky_users FROM report'),
      )
      for (const table of FLAG_TABLES) {
        expect(await asRole(pool, 'sr_mail_worker', (c) => sqlState(() => c.query(`SELECT * FROM ${table}`)))).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      }
      expect(
        await asRole(pool, 'sr_mail_worker', (c) =>
          sqlState(() => c.query('SELECT user_id FROM report_risky_user_flag')),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('grants nothing to PUBLIC', async () => {
      const { rows } = await pool.query(
        `SELECT c.relname AS table, bool_or(a.grantee = 0) AS public
           FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.relname = ANY($1) AND c.relnamespace = 'public'::regnamespace
          GROUP BY c.relname ORDER BY c.relname`,
        [FLAG_TABLES],
      )
      expect(rows).toEqual(FLAG_TABLES.map((table) => ({ table, public: false })))
    })
  })
})
