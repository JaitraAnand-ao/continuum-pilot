import { describe, expect, it } from 'vitest'
import {
  DEADLINE_CHECK_CRON,
  REPORT_DEADLINE_CHECK_QUEUE,
  REPORT_GENERATE_CRON,
  REPORT_GENERATE_QUEUE,
  startReportWorker,
  type JobQueue,
} from '../src/index.js'
import { FakeClock, FakeGraph, MemoryMetrics, MemoryStore, signIn } from './support/fakes.js'

type Handler = (jobs: { id: string; data: unknown }[]) => Promise<unknown>

class FakeQueue {
  readonly queues = new Map<string, unknown>()
  readonly schedules: { name: string; cron: string; data: unknown; options: unknown }[] = []
  readonly handlers = new Map<string, Handler>()

  async createQueue(name: string, options: unknown) {
    this.queues.set(name, options)
  }

  async schedule(name: string, cron: string, data: unknown, options: unknown) {
    this.schedules.push({ name, cron, data, options })
  }

  async work(name: string, _options: unknown, handler: Handler) {
    this.handlers.set(name, handler)
    return `worker-${name}`
  }

  run(name: string, data: unknown) {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`no worker for ${name}`)
    return handler([{ id: 'job-1', data }])
  }
}

function setup(at = '2026-10-12T02:00:00Z') {
  const clock = new FakeClock(at)
  const graph = new FakeGraph(clock)
  const store = new MemoryStore()
  const metrics = new MemoryMetrics()
  const queue = new FakeQueue()
  return { clock, graph, store, metrics, queue, deps: { clock, sleeper: clock, graph, store, metrics } }
}

describe('startReportWorker', () => {
  it('schedules report.generate at 02:00 UTC and the complete-report check at 07:30 UTC', async () => {
    const { queue, deps } = setup()
    await startReportWorker(queue as unknown as JobQueue, deps)

    expect(REPORT_GENERATE_QUEUE).toBe('report.generate')
    expect(REPORT_GENERATE_CRON).toBe('0 2 * * *')
    expect(DEADLINE_CHECK_CRON).toBe('30 7 * * *')
    expect(queue.schedules).toEqual([
      { name: REPORT_GENERATE_QUEUE, cron: '0 2 * * *', data: {}, options: { tz: 'UTC' } },
      { name: REPORT_DEADLINE_CHECK_QUEUE, cron: '30 7 * * *', data: {}, options: { tz: 'UTC' } },
    ])
    expect(queue.queues.get(REPORT_GENERATE_QUEUE)).toMatchObject({ policy: 'singleton', expireInHours: 6 })
    expect(queue.queues.get(REPORT_DEADLINE_CHECK_QUEUE)).toMatchObject({ policy: 'singleton' })
    expect([...queue.handlers.keys()]).toEqual([REPORT_GENERATE_QUEUE, REPORT_DEADLINE_CHECK_QUEUE])
  })

  it('AC-1: the 02:00 UTC run on 12 October reports on 11 October, and an explicit date is honoured', async () => {
    const { queue, store, graph, deps } = setup()
    graph.addSignIns(signIn('s1', '2026-10-11T12:00:00Z', 'interactiveUser'))
    await startReportWorker(queue as unknown as JobQueue, deps)

    await queue.run(REPORT_GENERATE_QUEUE, {})
    await queue.run(REPORT_GENERATE_QUEUE, {
      reportDate: '2026-10-05',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    })

    expect([...store.published.keys()].sort()).toEqual(['2026-10-05', '2026-10-11'])
  })

  it('AC-1: fourteen consecutive daily runs leave exactly one published report per previous UTC day', async () => {
    const { queue, store, clock, deps } = setup()
    await startReportWorker(queue as unknown as JobQueue, deps)

    for (let day = 0; day < 14; day += 1) {
      clock.set(new Date(Date.parse('2026-10-06T02:00:00Z') + day * 86_400_000).toISOString())
      await queue.run(REPORT_GENERATE_QUEUE, {})
      /* pg-boss may deliver the same scheduled job twice; it must change nothing. */
      await queue.run(REPORT_GENERATE_QUEUE, {})
    }

    const dates = [...store.published.keys()].sort()
    expect(dates).toHaveLength(14)
    expect(dates[0]).toBe('2026-10-05')
    expect(dates[13]).toBe('2026-10-18')
    for (const date of dates) {
      const report = store.published.get(date)
      expect(report?.reportDate).toBe(date)
      expect(Date.parse(report?.publishedAt ?? '')).toBeLessThan(Date.parse(`${date}T00:00:00Z`) + 32 * 3_600_000)
    }
  })

  it('AC-6: the 07:30 job emits the complete-report metric', async () => {
    const { queue, metrics, clock, deps } = setup()
    await startReportWorker(queue as unknown as JobQueue, deps)
    clock.set('2026-10-12T07:30:00Z')

    await queue.run(REPORT_DEADLINE_CHECK_QUEUE, {})

    expect(metrics.named('CompleteReportMissing')).toEqual([
      { namespace: 'SigninReports', name: 'CompleteReportMissing', value: 1, unit: 'Count' },
    ])
  })

  it('rejects a malformed payload instead of guessing a date', async () => {
    const { queue, store, deps } = setup()
    await startReportWorker(queue as unknown as JobQueue, deps)

    for (const data of [
      null,
      'x',
      { reportDate: 20261011 },
      { reportDate: '2026-10-11', extra: 1 },
      { traceparent: 7 },
    ]) {
      await expect(queue.run(REPORT_GENERATE_QUEUE, data), JSON.stringify(data)).rejects.toThrow(TypeError)
    }
    expect(store.publishCalls).toBe(0)
  })
})
