import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  contentHash,
  createPgReportStore,
  generateReport,
  previousUtcDate,
  publishDeadline,
  SIGN_IN_TYPES,
  SOURCE_NAMES,
  type GenerateDeps,
  type RiskDetection,
  type SignIn,
} from '../src/index.js'
import { FakeClock, FakeSleeper, RecordingMetrics, riskDetection, ScriptedGraph, signIn } from './support/fakes.js'
import { databaseUrl, reportSchema } from './support/postgres.js'

describe.skipIf(!databaseUrl)('report store on PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof reportSchema>>
  let store: ReturnType<typeof createPgReportStore>

  beforeAll(async () => {
    database = await reportSchema()
    store = createPgReportStore(database.db)
  })
  afterAll(async () => {
    await database?.drop()
  })

  function run(date: string, data: { signIns?: SignIn[]; risk?: RiskDetection[]; pageSize?: number }) {
    const clock = new FakeClock(`${date}T02:00:00.000Z`)
    clock.advance(24 * 3_600_000)
    const graph = new ScriptedGraph(clock, data)
    const metrics = new RecordingMetrics()
    const deps: GenerateDeps = { clock, sleeper: new FakeSleeper(clock), signIns: graph, risk: graph, store, metrics }
    return { clock, graph, metrics, deps }
  }

  it('@AC-1 @AC-2 publishes one report for the exact window with every type, its CA results and device details', async () => {
    const signIns = [
      ...SIGN_IN_TYPES.map((type) => signIn({ type, createdAt: '2026-09-01T10:00:00.000Z' })),
      signIn({ createdAt: '2026-09-01T23:59:59.999Z', errorCode: 50126 }),
      signIn({ createdAt: '2026-09-02T00:00:00.000Z' }),
    ]
    const risk = [riskDetection({ detectedAt: '2026-09-01T08:00:00.000Z' })]
    const { deps } = run('2026-09-01', { signIns, risk, pageSize: 2 })

    const outcome = await generateReport('2026-09-01', deps)

    const report = await store.findPublished('2026-09-01')
    expect(outcome.kind === 'published' && outcome.report).toEqual(report)
    expect(report?.windowStart).toBe('2026-09-01T00:00:00.000Z')
    expect(report?.windowEnd).toBe('2026-09-02T00:00:00.000Z')
    expect(new Date(report?.publishedAt as string).getTime()).toBeLessThan(publishDeadline('2026-09-01').getTime())
    expect(report?.totals).toEqual({ total: 5, successful: 4, failed: 1 })

    const snapshot = await store.loadSnapshot(report?.id as string)
    expect(snapshot.signIns).toHaveLength(5)
    expect(snapshot.signIns).toEqual(expect.arrayContaining(signIns.slice(0, 5)))
    expect(snapshot.signIns.map((stored) => stored.id)).not.toContain(signIns[5]?.id)
    expect(snapshot.riskDetections).toEqual(risk)
  })

  it('@AC-4 a re-run leaves the stored report and its hash unchanged, and the hash reproduces from the stored rows', async () => {
    const { deps } = run('2026-09-02', { signIns: [signIn({ createdAt: '2026-09-02T01:00:00.000Z' })] })
    await generateReport('2026-09-02', deps)
    const before = await store.findPublished('2026-09-02')

    const again = await generateReport('2026-09-02', deps)

    expect(again.kind).toBe('already-published')
    const all = await store.listPublished()
    expect(all.filter((report) => report.reportDate === '2026-09-02')).toHaveLength(1)
    expect(await store.findPublished('2026-09-02')).toEqual(before)

    const {
      id,
      reportDate,
      windowStart,
      windowEnd,
      complete,
      missingSources,
      totals,
      contentHash: stored,
    } = before as NonNullable<typeof before>
    const snapshot = await store.loadSnapshot(id)
    expect(contentHash({ reportDate, windowStart, windowEnd, complete, missingSources, totals, ...snapshot })).toBe(
      stored,
    )
  })

  it('@AC-4 two runs publishing the same day concurrently leave one report', async () => {
    const date = '2026-09-03'
    const first = run(date, { signIns: [signIn({ createdAt: `${date}T03:00:00.000Z` })] })
    const second = run(date, { signIns: [signIn({ createdAt: `${date}T04:00:00.000Z` })] })

    const outcomes = await Promise.all([generateReport(date, first.deps), generateReport(date, second.deps)])

    const reports = (await store.listPublished()).filter((report) => report.reportDate === date)
    expect(reports).toHaveLength(1)
    const created = outcomes.filter((outcome) => outcome.kind === 'published' && outcome.created)
    expect(created).toHaveLength(1)
    for (const outcome of outcomes) expect(outcome.kind !== 'not-generated' && outcome.report).toEqual(reports[0])
    expect(await store.loadSnapshot(reports[0]?.id as string).then((s) => s.signIns)).toHaveLength(1)
  })

  it('@AC-4 published rows cannot be updated', async () => {
    await expect(database.db.executeSql(`UPDATE report SET total_count = total_count`, [])).rejects.toThrow('immutable')
  })

  it('@AC-5 publishes a report marked incomplete naming Identity Protection risk data', async () => {
    const { deps, graph } = run('2026-09-04', { signIns: [signIn({ createdAt: '2026-09-04T05:00:00.000Z' })] })
    graph.failWith = (call) => (call.source === 'risk' ? new Error('503') : undefined)

    await generateReport('2026-09-04', deps)

    const report = await store.findPublished('2026-09-04')
    expect(report?.complete).toBe(false)
    expect(report?.missingSources).toEqual([SOURCE_NAMES.identityProtection])
  })

  it('@AC-5 records a day as not generated, with no report shown as complete, when nothing is collected', async () => {
    const { deps, graph } = run('2026-09-05', { signIns: [signIn({ createdAt: '2026-09-05T05:00:00.000Z' })] })
    graph.failWith = () => new Error('500')

    await generateReport('2026-09-05', deps)
    await generateReport('2026-09-05', deps)

    expect(await store.isRecordedNotGenerated('2026-09-05')).toBe(true)
    expect(await store.findPublished('2026-09-05')).toBeUndefined()
    expect(await store.isRecordedNotGenerated('2026-09-01')).toBe(false)
  })

  it('@AC-7 a day without sign-ins is published with zero totals', async () => {
    const { deps } = run('2026-09-06', { signIns: [] })
    await generateReport('2026-09-06', deps)
    const report = await store.findPublished('2026-09-06')
    expect(report?.complete).toBe(true)
    expect(report?.totals).toEqual({ total: 0, successful: 0, failed: 0 })
  })

  it('@AC-1 fourteen consecutive scheduled runs leave exactly one report per day', async () => {
    const clock = new FakeClock('2026-08-02T02:00:00.000Z')
    const graph = new ScriptedGraph(clock, { signIns: [] })
    const deps: GenerateDeps = {
      clock,
      sleeper: new FakeSleeper(clock),
      signIns: graph,
      risk: graph,
      store,
      metrics: new RecordingMetrics(),
    }
    for (let day = 0; day < 14; day += 1) {
      await generateReport(previousUtcDate(clock.now()), deps)
      await generateReport(previousUtcDate(clock.now()), deps)
      clock.advance(24 * 3_600_000)
    }
    const august = (await store.listPublished()).filter((report) => report.reportDate.startsWith('2026-08'))
    expect(august.map((report) => report.reportDate)).toEqual(
      Array.from({ length: 14 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`),
    )
  })
})
