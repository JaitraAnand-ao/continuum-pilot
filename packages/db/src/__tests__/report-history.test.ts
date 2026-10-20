import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect } from '../client.js'
import { createReportHistory, type HistoryDay } from '../report-history.js'
import { asRole, migratedPool, noDatabase } from './db.js'

const HASH = 'b'.repeat(64)

const signIns = (failed: number, successful: number) => [
  ...Array.from({ length: failed }, (_, i) => ({ id: `f${i}`, errorCode: 50126 })),
  ...Array.from({ length: successful }, (_, i) => ({ id: `s${i}`, errorCode: 0 })),
]

const nextDay = (date: string) => {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

interface Seed {
  date: string
  failed: number
  successful: number
  publishedAt: string
  missing?: string[]
}

const insertReport = (client: pg.PoolClient, r: Seed) =>
  client.query(
    `INSERT INTO report (report_date, window_start, window_end, status, missing_sources,
                         total, successful, failed, snapshot, content_hash, published_at)
     VALUES ($1::date, $2::timestamptz, $3::timestamptz, $4, $5::text[], $6, $7, $8, $9::jsonb, $10, $11::timestamptz)`,
    [
      r.date,
      `${r.date}T00:00:00.000Z`,
      `${nextDay(r.date)}T00:00:00.000Z`,
      r.missing?.length ? 'incomplete' : 'complete',
      r.missing ?? [],
      r.failed + r.successful,
      r.successful,
      r.failed,
      JSON.stringify({ signIns: signIns(r.failed, r.successful), riskDetections: [] }),
      HASH,
      r.publishedAt,
    ],
  )

const insertNotGenerated = (client: pg.PoolClient, date: string, recordedAt: string) =>
  client.query(
    `INSERT INTO report_not_generated (report_date, missing_sources, recorded_at)
     VALUES ($1::date, ARRAY['signIns.interactiveUser']::text[], $2::timestamptz)`,
    [date, recordedAt],
  )

/* Seeds as the owner, then reads as the BFF's role (sr_api) inside one transaction that is rolled back. */
async function readAsApi<T>(
  pool: pg.Pool,
  seed: (client: pg.PoolClient) => Promise<unknown>,
  read: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await seed(client)
    await client.query('SET LOCAL ROLE sr_api')
    /* A session outside UTC must still read the stored instants as UTC. */
    await client.query("SET LOCAL TimeZone = 'America/New_York'")
    return await read(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

describe('report history range', () => {
  it('rejects a bound that is not a calendar date', async () => {
    const history = createReportHistory(connect({} as pg.Client))
    await expect(history.list({ from: '2026-10-1', to: '2026-10-31' })).rejects.toThrow(RangeError)
    await expect(history.list({ from: '2026-10-01', to: '2026-13-01' })).rejects.toThrow(RangeError)
    await expect(history.list({ from: '2026-02-30', to: '2026-03-01' })).rejects.toThrow(RangeError)
    await expect(history.list({ from: '0000-12-31', to: '2026-03-01' })).rejects.toThrow(RangeError)
  })

  it('rejects a range that ends before it starts', async () => {
    const history = createReportHistory(connect({} as pg.Client))
    await expect(history.list({ from: '2026-10-02', to: '2026-10-01' })).rejects.toThrow(RangeError)
  })
})

describe.skipIf(noDatabase)('report history (ST-7)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = await migratedPool()
  })
  afterAll(async () => {
    await pool?.end()
  })

  it('lists each stored day newest first with its figures, publish time or not-generated record', async () => {
    const days = await readAsApi(
      pool,
      async (c) => {
        await insertReport(c, { date: '2026-10-05', failed: 1, successful: 3, publishedAt: '2026-10-06T02:00:00.000Z' })
        await insertNotGenerated(c, '2026-10-06', '2026-10-07T07:00:00.000Z')
        await insertReport(c, {
          date: '2026-10-07',
          failed: 2,
          successful: 0,
          publishedAt: '2026-10-08T07:42:00.123Z',
          missing: ['signIns.managedIdentity'],
        })
      },
      (c) => createReportHistory(connect(c)).list({ from: '2026-10-01', to: '2026-10-31' }),
    )
    expect(days).toEqual<HistoryDay[]>([
      {
        kind: 'report',
        reportDate: '2026-10-07',
        status: 'incomplete',
        total: 2,
        successful: 0,
        failed: 2,
        publishedAt: '2026-10-08T07:42:00.123Z',
      },
      { kind: 'not_generated', reportDate: '2026-10-06', recordedAt: '2026-10-07T07:00:00.000Z' },
      {
        kind: 'report',
        reportDate: '2026-10-05',
        status: 'complete',
        total: 4,
        successful: 3,
        failed: 1,
        publishedAt: '2026-10-06T02:00:00.000Z',
      },
    ])
  })

  it('returns figures that reconcile to the stored snapshot', async () => {
    const { days, counted } = await readAsApi(
      pool,
      (c) => insertReport(c, { date: '2026-10-11', failed: 3, successful: 4, publishedAt: '2026-10-12T02:00:00Z' }),
      async (c) => {
        const days = await createReportHistory(connect(c)).list({ from: '2026-10-11', to: '2026-10-11' })
        const { rows } = await c.query<{ total: number; failed: number }>(
          `SELECT jsonb_array_length(snapshot -> 'signIns') AS total,
                  (SELECT count(*)::int FROM jsonb_array_elements(snapshot -> 'signIns') s
                    WHERE (s ->> 'errorCode')::int <> 0) AS failed
             FROM report WHERE report_date = '2026-10-11'`,
        )
        return { days, counted: rows[0] }
      },
    )
    expect(days).toHaveLength(1)
    expect(days[0]).toMatchObject({ kind: 'report', total: counted?.total, failed: counted?.failed })
  })

  it('includes both bounds of the range and nothing one day outside them', async () => {
    const days = await readAsApi(
      pool,
      async (c) => {
        for (const date of ['2026-07-22', '2026-07-23', '2026-10-19', '2026-10-20']) {
          await insertReport(c, { date, failed: 0, successful: 1, publishedAt: `${nextDay(date)}T02:00:00.000Z` })
        }
        for (const date of ['2026-07-21', '2026-07-24', '2026-10-18', '2026-10-21']) {
          await insertNotGenerated(c, date, `${nextDay(date)}T07:00:00.000Z`)
        }
      },
      async (c) =>
        (await createReportHistory(connect(c)).list({ from: '2026-07-22', to: '2026-10-20' })).map(
          (d) => `${d.reportDate} ${d.kind}`,
        ),
    )
    expect(days).toEqual([
      '2026-10-20 report',
      '2026-10-19 report',
      '2026-10-18 not_generated',
      '2026-07-24 not_generated',
      '2026-07-23 report',
      '2026-07-22 report',
    ])
  })

  it('lists a not-generated day on either bound and nothing one day outside them', async () => {
    const dates = await readAsApi(
      pool,
      async (c) => {
        for (const date of ['2026-07-22', '2026-07-23', '2026-10-19', '2026-10-20']) {
          await insertNotGenerated(c, date, `${nextDay(date)}T07:00:00.000Z`)
        }
      },
      async (c) =>
        (await createReportHistory(connect(c)).list({ from: '2026-07-23', to: '2026-10-19' })).map((d) => d.reportDate),
    )
    expect(dates).toEqual(['2026-10-19', '2026-07-23'])
  })

  it('shows a day that was published after being recorded as not generated as its report only', async () => {
    const days = await readAsApi(
      pool,
      async (c) => {
        await insertNotGenerated(c, '2026-10-09', '2026-10-10T07:00:00.000Z')
        await insertReport(c, { date: '2026-10-09', failed: 0, successful: 1, publishedAt: '2026-10-10T07:30:00.000Z' })
      },
      (c) => createReportHistory(connect(c)).list({ from: '2026-10-09', to: '2026-10-09' }),
    )
    expect(days).toEqual([expect.objectContaining({ kind: 'report', reportDate: '2026-10-09' })])
  })

  it('is empty before the first report exists', async () => {
    const days = await readAsApi(
      pool,
      async () => {},
      (c) => createReportHistory(connect(c)).list({ from: '2026-07-23', to: '2026-10-20' }),
    )
    expect(days).toEqual([])
  })

  it('never reads the snapshot evidence', async () => {
    const statements: string[] = []
    await readAsApi(
      pool,
      (c) => insertReport(c, { date: '2026-10-11', failed: 0, successful: 1, publishedAt: '2026-10-12T02:00:00Z' }),
      async (c) => {
        const spy = {
          query: (...args: Parameters<pg.PoolClient['query']>) => {
            statements.push(typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text)
            return (c.query as (...a: unknown[]) => unknown)(...args)
          },
        }
        return createReportHistory(connect(spy as unknown as pg.PoolClient)).list({
          from: '2026-10-01',
          to: '2026-10-31',
        })
      },
    )
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) expect(statement).not.toMatch(/snapshot/i)
  })

  it('refuses a role without the grant, handing back the driver error without the bound parameters', async () => {
    const error = await asRole(pool, 'sr_mail_worker', (c) =>
      createReportHistory(connect(c))
        .list({ from: '2026-10-01', to: '2026-10-31' })
        .then(
          () => null,
          (e: unknown) => e as Error & { code?: string },
        ),
    )
    expect(error?.code).toBe('42501')
    expect(error?.message).not.toContain('2026-10-01')
  })

  it('is readable by the report worker, which records the days it lists', async () => {
    const days = await asRole(pool, 'sr_report_worker', (c) =>
      createReportHistory(connect(c)).list({ from: '2026-10-01', to: '2026-10-31' }),
    )
    expect(days).toEqual([])
  })
})
