import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CHECK_VIOLATION,
  contentHash,
  migratedPool,
  noDatabase,
  publish,
  RAISED,
  RECORD_NOT_GENERATED,
  report,
  rolledBack,
  signIn,
  sqlState,
  tryPublish,
} from './support.js'

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`
const READ_REPORT = `
  SELECT report_date::text AS "reportDate",
         to_char(window_start AT TIME ZONE 'UTC', ${UTC_ISO}) AS "windowStart",
         to_char(window_end AT TIME ZONE 'UTC', ${UTC_ISO}) AS "windowEnd",
         status, missing_sources AS "missingSources", total, successful, failed, snapshot,
         content_hash AS "contentHash",
         to_char(published_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS "publishedAt"
    FROM report WHERE report_date = $1::date`

const readReport = async (client: pg.PoolClient, reportDate: string) =>
  (await client.query(READ_REPORT, [reportDate])).rows[0] as Record<string, unknown> | undefined

const reportCount = async (client: pg.PoolClient, reportDate: string) =>
  (await client.query('SELECT count(*)::int AS n FROM report WHERE report_date = $1::date', [reportDate])).rows[0].n

describe.skipIf(noDatabase)('report storage (ST-2)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = await migratedPool()
  })
  afterAll(async () => {
    await pool?.end()
  })

  describe('AC-1: one report per UTC day', () => {
    it('stores the report for 2026-10-11 with the window 2026-10-11T00:00Z to 2026-10-12T00:00Z', async () => {
      await rolledBack(pool, async (client) => {
        const row = report('2026-10-11', [signIn()])
        await publish(client, row)
        expect(await reportCount(client, '2026-10-11')).toBe(1)
        expect(await readReport(client, '2026-10-11')).toMatchObject({
          windowStart: '2026-10-11T00:00:00.000Z',
          windowEnd: '2026-10-12T00:00:00.000Z',
          publishedAt: '2026-10-12T02:05:00.000Z',
        })
      })
    })

    it('rejects a window that is not exactly the report date in UTC', async () => {
      await rolledBack(pool, async (client) => {
        const shifted = { windowStart: '2026-10-10T22:00:00.000Z', windowEnd: '2026-10-11T22:00:00.000Z' }
        expect(await tryPublish(client, report('2026-10-11', [], shifted))).toBe(CHECK_VIOLATION)
        expect(await tryPublish(client, report('2026-10-11', [], { windowEnd: '2026-10-12T00:00:00.001Z' }))).toBe(
          CHECK_VIOLATION,
        )
        expect(await tryPublish(client, report('2026-10-11', [], { windowEnd: '2026-10-11T23:59:59.999Z' }))).toBe(
          CHECK_VIOLATION,
        )
      })
    })

    it('cannot be published before its day has ended: at 00:00Z of D+1 it can, one millisecond earlier it cannot', async () => {
      await rolledBack(pool, async (client) => {
        expect(await tryPublish(client, report('2026-10-11', [], { publishedAt: '2026-10-11T23:59:59.999Z' }))).toBe(
          CHECK_VIOLATION,
        )
        expect(await tryPublish(client, report('2026-10-11', [], { publishedAt: '2026-10-12T00:00:00.000Z' }))).toBe(
          null,
        )
      })
    })

    it('holds exactly one published report for each of 14 consecutive days', async () => {
      await rolledBack(pool, async (client) => {
        const days = Array.from({ length: 14 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
        for (const day of days) {
          await publish(client, report(day))
          const late = signIn({ id: 'late', createdDateTime: `${day}T08:00:00.000Z` })
          await publish(client, report(day, [late]))
        }
        const { rows } = await client.query(
          `SELECT report_date::text AS day, count(*)::int AS n FROM report
            WHERE report_date BETWEEN '2026-09-01' AND '2026-09-14' GROUP BY report_date ORDER BY report_date`,
        )
        expect(rows).toEqual(days.map((day) => ({ day, n: 1 })))
      })
    })
  })

  describe('AC-2: the snapshot', () => {
    it('holds all four sign-in types, each with its Conditional Access results and device details', async () => {
      await rolledBack(pool, async (client) => {
        const types = ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity']
        const signIns = types.map((type, i) => signIn({ id: `s-${i}`, signInEventType: type }))
        await publish(client, report('2026-10-11', signIns))
        const { rows } = await client.query(
          `SELECT s->>'signInEventType' AS type,
                  jsonb_typeof(s->'conditionalAccessPolicies') AS ca,
                  s->'deviceDetail'->>'deviceId' AS device
             FROM report, jsonb_array_elements(snapshot->'signIns') AS s
            WHERE report_date = '2026-10-11' ORDER BY s->>'id'`,
        )
        expect(rows).toEqual(types.map((type) => ({ type, ca: 'array', device: 'd-1' })))
      })
    })

    it('rejects a sign-in of an unknown type, or one without CA results or device details', async () => {
      const broken = [
        { ...signIn(), signInEventType: 'unknownFutureValue' },
        { ...signIn(), conditionalAccessPolicies: undefined },
        { ...signIn(), deviceDetail: undefined },
        { ...signIn(), deviceDetail: 'Windows' },
        { ...signIn(), id: undefined },
        { ...signIn(), errorCode: '0' },
        { ...signIn(), createdDateTime: undefined },
        { ...signIn(), createdDateTime: '2026-10-11 12:00:00' },
      ]
      await rolledBack(pool, async (client) => {
        for (const bad of broken) {
          const row = report('2026-10-11', [bad as never], { successful: 1, failed: 0, total: 1 })
          expect(await tryPublish(client, row)).toBe(CHECK_VIOLATION)
        }
      })
    })

    it('includes 23:59:59.999 on D and 00:00:00.000 on D, and rejects 00:00:00.000 on D+1 and 23:59:59.999 on D-1', async () => {
      await rolledBack(pool, async (client) => {
        const inside = [
          signIn({ id: 'last', createdDateTime: '2026-10-11T23:59:59.999Z' }),
          signIn({ id: 'first', createdDateTime: '2026-10-11T00:00:00.000Z' }),
        ]
        for (const outside of ['2026-10-12T00:00:00.000Z', '2026-10-10T23:59:59.999Z']) {
          const row = report('2026-10-11', [...inside, signIn({ id: 'out', createdDateTime: outside })])
          expect(await tryPublish(client, row)).toBe(CHECK_VIOLATION)
        }
        expect(await tryPublish(client, report('2026-10-11', inside))).toBe(null)
      })
    })
  })

  describe('AC-3: the snapshot count equals what Graph holds', () => {
    it('stores 184,312 sign-ins collected across many pages and reconciles every figure to them', async () => {
      await rolledBack(pool, async (client) => {
        await client.query(
          `INSERT INTO report (report_date, window_start, window_end, status, missing_sources,
                               total, successful, failed, snapshot, content_hash, published_at)
           SELECT '2026-10-11', '2026-10-11T00:00:00Z', '2026-10-12T00:00:00Z', 'complete', '{}',
                  184312, 184312 - 18431, 18431,
                  jsonb_build_object('riskDetections', '[]'::jsonb, 'signIns', jsonb_agg(jsonb_build_object(
                    'id', 'sign-in-' || n,
                    'createdDateTime', to_char((timestamptz '2026-10-11T00:00:00Z' + n * interval '468 milliseconds')
                                               AT TIME ZONE 'UTC', ${UTC_ISO}),
                    'signInEventType', (ARRAY['interactiveUser','nonInteractiveUser','servicePrincipal','managedIdentity'])[1 + n % 4],
                    'errorCode', CASE WHEN n % 10 = 0 THEN 50126 ELSE 0 END,
                    'conditionalAccessPolicies', '[]'::jsonb,
                    'deviceDetail', '{}'::jsonb))),
                  repeat('a', 64), '2026-10-12T03:00:00Z'
             FROM generate_series(1, 184312) AS n`,
        )
        const { rows } = await client.query(
          `SELECT total, jsonb_array_length(snapshot->'signIns') AS stored FROM report WHERE report_date = '2026-10-11'`,
        )
        expect(rows[0]).toEqual({ total: 184312, stored: 184312 })
      })
    }, 60_000)

    it('rejects totals that do not reconcile to the snapshot, one off in either direction', async () => {
      const signIns = [signIn({ id: 'ok' }), signIn({ id: 'bad', errorCode: 50126 })]
      await rolledBack(pool, async (client) => {
        for (const figures of [
          { total: 3, successful: 2, failed: 1 },
          { total: 1, successful: 1, failed: 0 },
          { total: 2, successful: 2, failed: 0 },
          { total: 2, successful: 0, failed: 2 },
          { total: 2, successful: 1, failed: 2 },
          { total: -1, successful: 0, failed: -1 },
        ]) {
          expect(await tryPublish(client, report('2026-10-11', signIns, figures))).toBe(CHECK_VIOLATION)
        }
        expect(await tryPublish(client, report('2026-10-11', signIns))).toBe(null)
      })
    })

    it('rejects a snapshot holding the same sign-in twice, as a re-fetched page would', async () => {
      await rolledBack(pool, async (client) => {
        const row = report('2026-10-11', [signIn({ id: 'dup' }), signIn({ id: 'dup' })])
        expect(await tryPublish(client, row)).toBe(CHECK_VIOLATION)
      })
    })

    it('rejects a snapshot without its sign-ins or risk detections array', async () => {
      await rolledBack(pool, async (client) => {
        for (const snapshot of [{ signIns: [] }, { riskDetections: [] }, { signIns: {}, riskDetections: [] }]) {
          expect(await tryPublish(client, report('2026-10-11', [], { snapshot: snapshot as never }))).toBe(
            CHECK_VIOLATION,
          )
        }
      })
    })
  })

  describe('AC-4: a re-run neither duplicates nor alters a published report', () => {
    it('keeps one report with its content hash when the job publishes the same date again', async () => {
      await rolledBack(pool, async (client) => {
        const first = report('2026-10-11', [signIn({ id: 'a' }), signIn({ id: 'b', errorCode: 50126 })])
        await publish(client, first)
        const rerun = report('2026-10-11', [signIn({ id: 'a' })], { publishedAt: '2026-10-12T06:00:00.000Z' })
        const result = await publish(client, rerun)
        expect(result.rowCount).toBe(0)
        expect(await reportCount(client, '2026-10-11')).toBe(1)
        expect(await readReport(client, '2026-10-11')).toMatchObject({
          contentHash: first.contentHash,
          publishedAt: first.publishedAt,
        })
      })
    })

    it('reads back exactly what was hashed', async () => {
      await rolledBack(pool, async (client) => {
        const row = report('2026-10-11', [signIn({ id: 'a', errorCode: 50126 }), signIn({ id: 'b' })], {
          snapshot: {
            signIns: [signIn({ id: 'a', errorCode: 50126 }), signIn({ id: 'b' })],
            riskDetections: [{ id: 'r1', riskLevel: 'high' }],
          },
        })
        await publish(client, row)
        const stored = await readReport(client, '2026-10-11')
        expect(stored).toEqual(row)
        const { contentHash: hash, ...hashed } = stored as Record<string, unknown>
        void hash
        expect(contentHash(hashed)).toBe(row.contentHash)
      })
    })

    it('rejects every UPDATE of a published report, and TRUNCATE', async () => {
      await rolledBack(pool, async (client) => {
        await publish(client, report('2026-10-11', [signIn()]))
        for (const statement of [
          `UPDATE report SET content_hash = repeat('f', 64) WHERE report_date = '2026-10-11'`,
          `UPDATE report SET published_at = published_at WHERE report_date = '2026-10-11'`,
          `INSERT INTO report SELECT * FROM report WHERE report_date = '2026-10-11'
             ON CONFLICT (report_date) DO UPDATE SET status = 'incomplete'`,
          'TRUNCATE report',
        ]) {
          expect(await sqlState(client, statement)).toBe(RAISED)
        }
        expect(await reportCount(client, '2026-10-11')).toBe(1)
      })
    })

    it('rejects a content hash that is not a lowercase SHA-256 hex digest', async () => {
      await rolledBack(pool, async (client) => {
        for (const contentHash of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '']) {
          expect(await tryPublish(client, report('2026-10-11', [], { contentHash }))).toBe(CHECK_VIOLATION)
        }
      })
    })
  })

  describe('AC-5: an incomplete day is never shown as complete', () => {
    it('stores a report marked incomplete that names Identity Protection risk data as missing', async () => {
      await rolledBack(pool, async (client) => {
        const row = report('2026-10-11', [signIn()], {
          status: 'incomplete',
          missingSources: ['identityProtection.riskDetections'],
        })
        await publish(client, row)
        expect(await readReport(client, '2026-10-11')).toMatchObject({
          status: 'incomplete',
          missingSources: ['identityProtection.riskDetections'],
        })
      })
    })

    it('accepts each of the five sources as missing and nothing else', async () => {
      await rolledBack(pool, async (client) => {
        for (const source of [
          'signIns.interactiveUser',
          'signIns.nonInteractiveUser',
          'signIns.servicePrincipal',
          'signIns.managedIdentity',
          'identityProtection.riskDetections',
        ]) {
          const row = report('2026-10-11', [], { status: 'incomplete', missingSources: [source] })
          expect(await tryPublish(client, row)).toBe(null)
          await client.query(`DELETE FROM report WHERE report_date = '2026-10-11'`)
        }
        const unknown = report('2026-10-11', [], { status: 'incomplete', missingSources: ['auditLogs.directory'] })
        expect(await tryPublish(client, unknown)).toBe(CHECK_VIOLATION)
      })
    })

    it('rejects a complete report with a missing source, an incomplete one without, and an unknown status', async () => {
      await rolledBack(pool, async (client) => {
        const missing = ['identityProtection.riskDetections']
        expect(await tryPublish(client, report('2026-10-11', [], { missingSources: missing }))).toBe(CHECK_VIOLATION)
        expect(await tryPublish(client, report('2026-10-11', [], { status: 'incomplete' }))).toBe(CHECK_VIOLATION)
        expect(await tryPublish(client, report('2026-10-11', [], { status: 'partial', missingSources: missing }))).toBe(
          CHECK_VIOLATION,
        )
      })
    })

    it('records a day as not generated, and lets the job record it again at the cut-off', async () => {
      await rolledBack(pool, async (client) => {
        const all = [
          'signIns.interactiveUser',
          'signIns.nonInteractiveUser',
          'signIns.servicePrincipal',
          'signIns.managedIdentity',
          'identityProtection.riskDetections',
        ]
        await client.query(RECORD_NOT_GENERATED, ['2026-10-11', all, '2026-10-12T06:59:00.000Z'])
        await client.query(RECORD_NOT_GENERATED, ['2026-10-11', all, '2026-10-12T07:00:00.000Z'])
        const { rows } = await client.query(
          `SELECT missing_sources, to_char(recorded_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS recorded_at
             FROM report_not_generated WHERE report_date = '2026-10-11'`,
        )
        expect(rows).toEqual([{ missing_sources: all, recorded_at: '2026-10-12T07:00:00.000Z' }])
        expect(await reportCount(client, '2026-10-11')).toBe(0)
      })
    })

    it('rejects a not-generated record naming no source, an unknown source, or dated before the day ended', async () => {
      await rolledBack(pool, async (client) => {
        expect(await sqlState(client, RECORD_NOT_GENERATED, ['2026-10-11', [], '2026-10-12T07:00:00Z'])).toBe(
          CHECK_VIOLATION,
        )
        expect(
          await sqlState(client, RECORD_NOT_GENERATED, ['2026-10-11', ['graph.everything'], '2026-10-12T07:00:00Z']),
        ).toBe(CHECK_VIOLATION)
        const source = ['signIns.interactiveUser']
        expect(await sqlState(client, RECORD_NOT_GENERATED, ['2026-10-11', source, '2026-10-11T23:59:59.999Z'])).toBe(
          CHECK_VIOLATION,
        )
        expect(await sqlState(client, RECORD_NOT_GENERATED, ['2026-10-11', source, '2026-10-12T00:00:00.000Z'])).toBe(
          null,
        )
      })
    })

    it('refuses to record a day as not generated once a report for it is published', async () => {
      await rolledBack(pool, async (client) => {
        await publish(client, report('2026-10-11'))
        const source = ['signIns.interactiveUser']
        expect(await sqlState(client, RECORD_NOT_GENERATED, ['2026-10-11', source, '2026-10-12T07:00:00Z'])).toBe(
          RAISED,
        )
        expect(await sqlState(client, RECORD_NOT_GENERATED, ['2026-10-10', source, '2026-10-12T07:00:00Z'])).toBe(null)
      })
    })
  })

  describe('AC-7: a day without sign-ins', () => {
    it('is published with total, successful and failed counts of 0', async () => {
      await rolledBack(pool, async (client) => {
        await publish(client, report('2026-10-11', []))
        expect(await readReport(client, '2026-10-11')).toMatchObject({ total: 0, successful: 0, failed: 0 })
      })
    })
  })
})
