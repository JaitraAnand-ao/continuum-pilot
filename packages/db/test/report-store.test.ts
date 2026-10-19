/* ST-2 (CMP-5): the report store publishes one immutable report per UTC day, snapshot and
 * figures in one transaction, and never replaces a report already recorded for that day. */
import { describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import { createReportStore, reports, signInTypes, SNAPSHOT_CHUNK_ROWS, type SnapshotSignIn } from '../src/index.js'
import { FakePgClient, row, type Handler } from './fake-pg.js'

const REPORT_ID = '0b5f4a52-6f3c-4e83-9d0a-8a4c7c1f9e21'
const CONFIG_VERSION = '6d0b7c8e-2f6a-4b1e-9c3d-5e4f3a2b1c0d'
const HASH = 'a'.repeat(64)
const windowStart = new Date('2026-10-11T00:00:00.000Z')
const windowEnd = new Date('2026-10-12T00:00:00.000Z')
const publishedAt = new Date('2026-10-12T02:04:00.000Z')

const signIn = (n: number, overrides: Partial<SnapshotSignIn> = {}): SnapshotSignIn => ({
  id: `sign-in-${n}`,
  type: signInTypes[n % signInTypes.length] ?? 'interactiveUser',
  createdAt: new Date(windowStart.getTime() + n),
  errorCode: n % 3 === 0 ? 50126 : 0,
  appliedConditionalAccessPolicies: [{ id: 'policy-1', result: 'success' }],
  deviceDetail: { deviceId: `device-${n}`, operatingSystem: 'Windows' },
  record: { id: `sign-in-${n}` },
  ...overrides,
})

const storedReport = (overrides: Record<string, unknown> = {}) =>
  row(reports, {
    id: REPORT_ID,
    reportDate: '2026-10-11',
    windowStart: '2026-10-11T00:00:00.000Z',
    windowEnd: '2026-10-12T00:00:00.000Z',
    status: 'complete',
    missingSources: [],
    totalCount: 2,
    successfulCount: 1,
    failedCount: 1,
    contentHash: HASH,
    configVersionId: CONFIG_VERSION,
    publishedAt: '2026-10-12T02:04:00.000Z',
    recordedAt: '2026-10-12T02:04:00.000Z',
    ...overrides,
  })

const publishInput = (signIns: readonly SnapshotSignIn[], missingSources: readonly string[] = []) => ({
  reportDate: '2026-10-11',
  windowStart,
  windowEnd,
  missingSources,
  totals: {
    total: signIns.length,
    successful: signIns.filter((s) => s.errorCode === 0).length,
    failed: signIns.filter((s) => s.errorCode !== 0).length,
  },
  contentHash: HASH,
  configVersionId: CONFIG_VERSION,
  publishedAt,
  signIns,
})

/** A database where no report for the day exists yet: the insert wins. */
const freshDay =
  (overrides: Record<string, unknown> = {}): Handler =>
  ({ text }) =>
    text.startsWith('insert into "reports"') ? [storedReport(overrides)] : []

const setup = (handler: Handler) => {
  const client = new FakePgClient(handler)
  return { client, store: createReportStore(drizzle({ client: client as never })) }
}

describe('publish (AC-1, AC-2, AC-3, AC-5, AC-7)', () => {
  it('writes the report row and its snapshot in one transaction', async () => {
    const { client, store } = setup(freshDay())
    const signIns = [signIn(1), signIn(3)]

    const result = await store.publish(publishInput(signIns))

    expect(result.outcome).toBe('published')
    const texts = client.texts()
    expect(texts[0]).toBe('begin')
    expect(texts[1]).toMatch(/^insert into "reports"/)
    expect(texts[1]).toMatch(/on conflict \("report_date"\) do nothing/)
    expect(texts[2]).toMatch(/^insert into "signin_snapshots"/)
    expect(texts.at(-1)).toBe('commit')
    expect(texts).toHaveLength(4)
  })

  it('stores the UTC day window, the figures, the hash and the config version on the report row', async () => {
    const { client, store } = setup(freshDay())

    await store.publish(publishInput([signIn(1), signIn(3)]))

    const insert = client.statements[1]
    expect(insert?.params).toEqual(
      expect.arrayContaining([
        '2026-10-11',
        '2026-10-11T00:00:00.000Z',
        '2026-10-12T00:00:00.000Z',
        'complete',
        2,
        1,
        HASH,
        CONFIG_VERSION,
        '2026-10-12T02:04:00.000Z',
      ]),
    )
  })

  it('returns the stored report, read back from the row the database holds', async () => {
    const { store } = setup(freshDay())

    const { report } = await store.publish(publishInput([signIn(1), signIn(3)]))

    expect(report).toEqual({
      id: REPORT_ID,
      reportDate: '2026-10-11',
      windowStart,
      windowEnd,
      status: 'complete',
      missingSources: [],
      totalCount: 2,
      successfulCount: 1,
      failedCount: 1,
      contentHash: HASH,
      configVersionId: CONFIG_VERSION,
      publishedAt,
      recordedAt: publishedAt,
    })
  })

  it('stores each sign-in of all four types with its CA policy results and device details', async () => {
    const { client, store } = setup(freshDay())
    const signIns = signInTypes.map((type, n) =>
      signIn(n, {
        type,
        appliedConditionalAccessPolicies: [{ id: `policy-${type}`, result: 'failure' }],
        deviceDetail: { deviceId: `device-${type}` },
      }),
    )

    await store.publish(publishInput(signIns))

    const params = client.statements[2]?.params ?? []
    expect(params).toEqual(
      expect.arrayContaining(['interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity']),
    )
    for (const type of signInTypes) {
      expect(params).toContain(JSON.stringify([{ id: `policy-${type}`, result: 'failure' }]))
      expect(params).toContain(JSON.stringify({ deviceId: `device-${type}` }))
    }
    expect(params).toContain(REPORT_ID)
  })

  it('stores the 23:59:59.999 sign-in at millisecond precision', async () => {
    const { client, store } = setup(freshDay())
    const lastInstant = signIn(1, { createdAt: new Date('2026-10-11T23:59:59.999Z') })

    await store.publish(publishInput([lastInstant]))

    expect(client.statements[2]?.params).toContain('2026-10-11T23:59:59.999Z')
  })

  it('writes all 184,312 sign-ins of a large day, in chunks the driver accepts', async () => {
    const { client, store } = setup(freshDay({ totalCount: 184_312 }))
    const signIns = Array.from({ length: 184_312 }, (_, n) => signIn(n))

    await store.publish(publishInput(signIns))

    const snapshotInserts = client.statements.filter((s) => s.text.startsWith('insert into "signin_snapshots"'))
    expect(snapshotInserts).toHaveLength(Math.ceil(184_312 / SNAPSHOT_CHUNK_ROWS))
    const written = snapshotInserts.reduce((sum, s) => sum + s.params.filter((p) => p === REPORT_ID).length, 0)
    expect(written).toBe(184_312)
    for (const insert of snapshotInserts) expect(insert.params.length).toBeLessThan(65_535)
    expect(client.texts().at(-1)).toBe('commit')
  }, 60_000)

  it('a chunk exactly at the limit is one insert, one row more is two', async () => {
    for (const [count, inserts] of [
      [SNAPSHOT_CHUNK_ROWS, 1],
      [SNAPSHOT_CHUNK_ROWS + 1, 2],
    ] as const) {
      const { client, store } = setup(freshDay())
      await store.publish(publishInput(Array.from({ length: count }, (_, n) => signIn(n))))
      expect(client.texts().filter((t) => t.startsWith('insert into "signin_snapshots"'))).toHaveLength(inserts)
    }
  })

  it('publishes a day with no sign-ins as a report whose totals are zero and writes no snapshot rows', async () => {
    const { client, store } = setup(freshDay({ totalCount: 0, successfulCount: 0, failedCount: 0 }))

    const result = await store.publish(publishInput([]))

    expect(result.outcome).toBe('published')
    expect(client.statements[1]?.params).toEqual(expect.arrayContaining(['complete', 0]))
    expect(client.texts()).toEqual(['begin', expect.stringMatching(/^insert into "reports"/), 'commit'])
    expect(result.report).toMatchObject({ totalCount: 0, successfulCount: 0, failedCount: 0 })
  })

  it('marks the report incomplete and names the missing sources when a source failed', async () => {
    const { client, store } = setup(
      freshDay({ status: 'incomplete', missingSources: ['Identity Protection risk data'] }),
    )

    const result = await store.publish(publishInput([signIn(1)], ['Identity Protection risk data']))

    expect(client.statements[1]?.params).toEqual(expect.arrayContaining(['incomplete']))
    expect(client.statements[1]?.params).not.toContain('complete')
    expect(client.statements[1]?.text).toMatch(/"missing_sources"/)
    expect(result.report.status).toBe('incomplete')
    expect(result.report.missingSources).toEqual(['Identity Protection risk data'])
  })

  it('rolls the report back when its snapshot cannot be written', async () => {
    const { client, store } = setup((statement) => {
      if (statement.text.startsWith('insert into "signin_snapshots"')) throw new Error('outside the report window')
      return freshDay()(statement)
    })

    await expect(store.publish(publishInput([signIn(1)]))).rejects.toThrow()

    expect(client.texts().at(-1)).toBe('rollback')
    expect(client.texts()).not.toContain('commit')
  })
})

describe('re-runs (AC-4)', () => {
  const alreadyPublished: Handler = ({ text }) => (text.startsWith('select') ? [storedReport()] : [])

  it('leaves a published report untouched and writes no second snapshot', async () => {
    const { client, store } = setup(alreadyPublished)

    const result = await store.publish({ ...publishInput([signIn(1), signIn(3)]), contentHash: 'b'.repeat(64) })

    expect(result.outcome).toBe('already-recorded')
    expect(result.report.contentHash).toBe(HASH)
    expect(client.texts().some((t) => t.startsWith('insert into "signin_snapshots"'))).toBe(false)
    expect(client.texts().some((t) => /^(update|delete)/.test(t))).toBe(false)
  })

  it('does not overwrite a day already recorded as not generated', async () => {
    const { client, store } = setup(alreadyPublished)

    const result = await store.recordNotGenerated({
      reportDate: '2026-10-11',
      windowStart,
      windowEnd,
      missingSources: ['Sign-in logs'],
      configVersionId: CONFIG_VERSION,
      recordedAt: publishedAt,
    })

    expect(result.outcome).toBe('already-recorded')
    expect(client.texts().some((t) => /^(update|delete)/.test(t))).toBe(false)
  })

  it('fails loudly if the day is neither inserted nor found', async () => {
    const { client, store } = setup(() => [])

    await expect(store.publish(publishInput([signIn(1)]))).rejects.toThrow(/2026-10-11/)
    expect(client.texts().at(-1)).toBe('rollback')
  })
})

describe('recordNotGenerated (AC-5)', () => {
  it('records the day as not generated, with no hash, no publication and the missing sources', async () => {
    const { client, store } = setup(
      freshDay({
        status: 'not_generated',
        missingSources: ['Sign-in logs', 'Identity Protection risk data'],
        totalCount: 0,
        successfulCount: 0,
        failedCount: 0,
        contentHash: null,
        publishedAt: null,
      }),
    )

    const result = await store.recordNotGenerated({
      reportDate: '2026-10-11',
      windowStart,
      windowEnd,
      missingSources: ['Sign-in logs', 'Identity Protection risk data'],
      configVersionId: CONFIG_VERSION,
      recordedAt: new Date('2026-10-12T07:00:00.000Z'),
    })

    expect(result.outcome).toBe('published')
    const insert = client.statements.find((s) => s.text.startsWith('insert into "reports"'))
    expect(insert?.text).toMatch(/on conflict \("report_date"\) do nothing/)
    expect(insert?.params).toEqual(expect.arrayContaining(['not_generated', '2026-10-12T07:00:00.000Z']))
    expect(insert?.params).not.toContain('complete')
    expect(result.report).toMatchObject({ status: 'not_generated', contentHash: null, publishedAt: null })
    expect(client.texts().some((t) => t.startsWith('insert into "signin_snapshots"'))).toBe(false)
  })
})

describe('reads (AC-1, AC-6)', () => {
  it('finds the report for a date, or nothing', async () => {
    const found = setup(({ text }) => (text.startsWith('select') ? [storedReport()] : []))
    expect((await found.store.findByDate('2026-10-11'))?.id).toBe(REPORT_ID)
    expect(found.client.statements[0]?.params).toEqual(['2026-10-11', 1])

    const missing = setup(() => [])
    expect(await missing.store.findByDate('2026-10-11')).toBeUndefined()
  })

  it('lists only published reports in the date range, oldest first', async () => {
    const { client, store } = setup(({ text }) =>
      text.startsWith('select') ? [storedReport(), storedReport({ reportDate: '2026-10-12' })] : [],
    )

    const listed = await store.listPublished('2026-09-28', '2026-10-11')

    expect(listed.map((r) => r.reportDate)).toEqual(['2026-10-11', '2026-10-12'])
    const select = client.statements[0]
    expect(select?.text).toMatch(/"published_at" is not null/)
    expect(select?.text).toMatch(/order by "reports"."report_date" asc/)
    expect(select?.params).toEqual(['2026-09-28', '2026-10-11'])
  })

  it('says whether a complete report exists, so an incomplete or not-generated day raises the alarm', async () => {
    const complete = setup(({ text }) => (text.startsWith('select') ? [[1]] : []))
    expect(await complete.store.hasCompleteReport('2026-10-11')).toBe(true)
    expect(complete.client.statements[0]?.params).toEqual(['2026-10-11', 'complete', 1])

    const none = setup(() => [])
    expect(await none.store.hasCompleteReport('2026-10-11')).toBe(false)
  })

  it('counts the snapshot rows held for a report', async () => {
    const { client, store } = setup(({ text }) => (text.startsWith('select') ? [[184_312]] : []))

    expect(await store.countSnapshot(REPORT_ID)).toBe(184_312)
    expect(client.statements[0]?.text).toMatch(/from "signin_snapshots"/)
    expect(client.statements[0]?.params).toEqual([REPORT_ID])
  })
})
