import { describe, expect, it } from 'vitest'
import {
  checkJobHandler,
  generateJobHandler,
  QUEUE_CHECK,
  QUEUE_GENERATE,
  startReportWorker,
  type ReportWorkerBoss,
} from '../src/index.js'
import { FakeClock, FakeGraph, MemoryStore, RecordingMetrics, signIn } from './support.js'

function deps(at: string) {
  return {
    graph: new FakeGraph([signIn({ id: 'a' })]),
    store: new MemoryStore(),
    metrics: new RecordingMetrics(),
    clock: new FakeClock(at),
  }
}

describe('report.generate job', () => {
  it('a scheduled job without data reports on the previous UTC day', async () => {
    const d = deps('2026-10-12T02:00:00.000Z')
    await generateJobHandler(d)([{ data: {} }])
    expect([...d.store.reports.keys()]).toEqual(['2026-10-11'])
  })

  it('an explicit reportDate is honoured and a duplicate delivery creates nothing new', async () => {
    const d = deps('2026-10-12T02:00:00.000Z')
    const handler = generateJobHandler(d)
    await handler([{ data: { reportDate: '2026-10-09' } }, { data: { reportDate: '2026-10-09' } }])
    expect([...d.store.reports.keys()]).toEqual(['2026-10-09'])
  })

  it('rejects job data whose reportDate is not a calendar date', async () => {
    const d = deps('2026-10-12T02:00:00.000Z')
    await expect(generateJobHandler(d)([{ data: { reportDate: '11/10/2026' } }])).rejects.toThrow(/report date/)
    await expect(generateJobHandler(d)([{ data: { reportDate: 7 } }])).rejects.toThrow(/report date/)
    await expect(generateJobHandler(d)([{ data: null }])).rejects.toThrow(/job data/)
  })
})

describe('report.check job', () => {
  it('the 07:30 run checks the previous UTC day', async () => {
    const d = deps('2026-10-12T07:30:00.000Z')
    await checkJobHandler(d)([{ data: {} }])
    expect(d.metrics.emitted).toEqual([
      expect.objectContaining({ name: 'CompleteReportMissing', value: 1, timestamp: '2026-10-12T07:30:00.000Z' }),
    ])
  })
})

describe('startReportWorker', () => {
  it('creates both queues, schedules them at 02:00 and 07:30 UTC and starts their workers', async () => {
    const actions: unknown[][] = []
    const boss: ReportWorkerBoss = {
      createQueue: async (name) => {
        actions.push(['createQueue', name])
      },
      schedule: async (name, cron, data, options) => {
        actions.push(['schedule', name, cron, data, options])
      },
      work: async (name, options) => {
        actions.push(['work', name, options])
        return name
      },
    }
    await startReportWorker(boss, deps('2026-10-12T02:00:00.000Z'))
    expect(actions).toEqual([
      ['createQueue', QUEUE_GENERATE],
      ['createQueue', QUEUE_CHECK],
      ['schedule', QUEUE_GENERATE, '0 2 * * *', {}, { tz: 'UTC', singletonKey: QUEUE_GENERATE }],
      ['schedule', QUEUE_CHECK, '30 7 * * *', {}, { tz: 'UTC', singletonKey: QUEUE_CHECK }],
      ['work', QUEUE_GENERATE, { batchSize: 1 }],
      ['work', QUEUE_CHECK, { batchSize: 1 }],
    ])
  })
})
