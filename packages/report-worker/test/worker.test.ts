import { describe, expect, it } from 'vitest'
import {
  METRIC_NAMESPACE,
  METRICS,
  QUEUES,
  SCHEDULES,
  checkReportPresence,
  createInMemoryReportStore,
  generateReport,
  registerReportWorker,
  type BossLike,
  type GenerateDeps,
} from '../src/index.js'
import { FakeClock, FakeRiskSource, FakeSignInSource, RecordingMetrics, signIn } from './fakes.js'

class FakeBoss implements BossLike {
  readonly queues: string[] = []
  readonly schedules: { name: string; cron: string; options: { tz?: string } | undefined }[] = []
  readonly handlers = new Map<string, (jobs: { id: string; data: unknown }[]) => Promise<unknown>>()
  async createQueue(name: string) {
    this.queues.push(name)
  }
  async schedule(name: string, cron: string, _data?: object, options?: { tz?: string }) {
    this.schedules.push({ name, cron, options })
  }
  async work(name: string, handler: (jobs: { id: string; data: unknown }[]) => Promise<unknown>) {
    this.handlers.set(name, handler)
    return name
  }
  run(name: string, data: unknown) {
    return this.handlers.get(name)!([{ id: 'job-1', data }])
  }
}

function deps(clock: FakeClock): GenerateDeps & { metrics: RecordingMetrics } {
  const items = []
  for (let day = 1; day <= 20; day += 1) {
    items.push(signIn(`2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`))
  }
  return {
    clock,
    sleeper: clock,
    signIns: new FakeSignInSource(items),
    risk: new FakeRiskSource([]),
    store: createInMemoryReportStore(),
    metrics: new RecordingMetrics(),
  }
}

describe('pg-boss wiring', () => {
  it('schedules report.generate at 02:00 UTC and the presence check at 07:30 UTC', async () => {
    const boss = new FakeBoss()
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    await registerReportWorker(boss, deps(clock))
    expect(boss.queues).toEqual([QUEUES.generate, QUEUES.check])
    expect(boss.schedules).toEqual([
      { name: QUEUES.generate, cron: SCHEDULES.generate, options: { tz: 'UTC' } },
      { name: QUEUES.check, cron: SCHEDULES.check, options: { tz: 'UTC' } },
    ])
    expect(SCHEDULES).toEqual({ generate: '0 2 * * *', check: '30 7 * * *' })
    expect(QUEUES).toEqual({ generate: 'report.generate', check: 'report.check' })
  })

  it('AC-1: the 02:00 run on 12 October publishes the 11 October report', async () => {
    const boss = new FakeBoss()
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const d = deps(clock)
    await registerReportWorker(boss, d)
    await boss.run(QUEUES.generate, {})
    const reports = await d.store.list()
    expect(reports.map((r) => r.reportDate)).toEqual(['2026-10-11'])
    expect(reports[0]!.publishedAt < '2026-10-12T08:00:00.000Z').toBe(true)
  })

  it('AC-1: fourteen consecutive daily runs leave exactly one published report per day', async () => {
    const boss = new FakeBoss()
    const clock = new FakeClock('2026-10-02T02:00:00Z')
    const d = deps(clock)
    await registerReportWorker(boss, d)
    const expected: string[] = []
    for (let day = 2; day <= 15; day += 1) {
      clock.set(`2026-10-${String(day).padStart(2, '0')}T02:00:00Z`)
      await boss.run(QUEUES.generate, {})
      // pg-boss may deliver twice; the second delivery changes nothing.
      await boss.run(QUEUES.generate, {})
      expected.push(`2026-10-${String(day - 1).padStart(2, '0')}`)
    }
    const reports = await d.store.list()
    expect(reports.map((r) => r.reportDate)).toEqual(expected)
    expect(reports.every((r) => r.complete)).toBe(true)
  })

  it('accepts an explicit report date for a re-run and rejects a malformed one', async () => {
    const boss = new FakeBoss()
    const clock = new FakeClock('2026-10-15T09:00:00Z')
    const d = deps(clock)
    await registerReportWorker(boss, d)
    await boss.run(QUEUES.generate, { reportDate: '2026-10-11' })
    expect((await d.store.list()).map((r) => r.reportDate)).toEqual(['2026-10-11'])
    await expect(boss.run(QUEUES.generate, { reportDate: "2026-10-11'; drop" })).rejects.toThrow(/report date/)
    await expect(boss.run(QUEUES.generate, { reportDate: 20261011 })).rejects.toThrow(/report date/)
    await expect(boss.run(QUEUES.generate, null)).resolves.toBeDefined()
  })

  it('AC-6: the 07:30 check emits the missing-report metric for the alarm when D has no complete report', async () => {
    const boss = new FakeBoss()
    const clock = new FakeClock('2026-10-12T07:30:00Z')
    const d = deps(clock)
    await registerReportWorker(boss, d)
    await boss.run(QUEUES.check, {})
    expect(d.metrics.data).toEqual([
      { namespace: METRIC_NAMESPACE, name: METRICS.completeReportMissing, value: 1, dimensions: {} },
    ])
    expect(METRIC_NAMESPACE).toBe('SigninReports')
    expect(METRICS.completeReportMissing).toBe('CompleteReportMissing')
  })
})

describe('checkReportPresence (AC-6)', () => {
  it('reports 0 when a complete report exists for D', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const d = deps(clock)
    await generateReport(d, '2026-10-11')
    clock.set('2026-10-12T07:30:00Z')
    expect(await checkReportPresence(d, '2026-10-11')).toEqual({ reportDate: '2026-10-11', complete: true })
    expect(d.metrics.data.at(-1)).toEqual({
      namespace: METRIC_NAMESPACE,
      name: METRICS.completeReportMissing,
      value: 0,
      dimensions: {},
    })
  })

  it('reports 1 when the only report for D is incomplete', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const d = deps(clock)
    d.risk = new FakeRiskSource([], { failAlways: true })
    await generateReport(d, '2026-10-11')
    expect(await checkReportPresence(d, '2026-10-11')).toEqual({ reportDate: '2026-10-11', complete: false })
    expect(d.metrics.data.at(-1)).toMatchObject({ name: METRICS.completeReportMissing, value: 1 })
  })
})
