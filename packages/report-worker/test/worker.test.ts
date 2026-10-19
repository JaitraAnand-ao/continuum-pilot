import { describe, expect, it } from 'vitest'
import {
  DEADLINE_CHECK_CRON,
  DEADLINE_CHECK_QUEUE,
  GENERATE_CRON,
  GENERATE_EXPIRE_SECONDS,
  GENERATE_QUEUE,
  registerReportWorker,
  reportDateFor,
  type JobBoss,
} from '../src/index.js'
import {
  FakeClock,
  FakeSleeper,
  InMemoryReportStore,
  RecordingMetrics,
  ScriptedGraph,
  signIn,
} from './support/fakes.js'

type Handler = (jobs: { id: string; data: unknown }[]) => Promise<unknown>

class FakeBoss implements JobBoss {
  readonly queues: unknown[] = []
  readonly schedules: unknown[] = []
  readonly handlers = new Map<string, Handler>()
  async createQueue(name: string, options?: object) {
    this.queues.push({ name, ...options })
  }
  async schedule(name: string, cron: string, data?: object, options?: object) {
    this.schedules.push({ name, cron, data, options })
  }
  async work<T>(name: string, handler: (jobs: { id: string; data: T }[]) => Promise<unknown>) {
    this.handlers.set(name, handler as Handler)
    return name
  }
}

function setup() {
  const clock = new FakeClock('2026-10-12T02:00:00.000Z')
  const graph = new ScriptedGraph(clock, { signIns: [signIn()] })
  const store = new InMemoryReportStore()
  const metrics = new RecordingMetrics()
  const deps = { clock, sleeper: new FakeSleeper(clock), signIns: graph, risk: graph, store, metrics }
  return { clock, store, metrics, deps, boss: new FakeBoss() }
}

describe('pg-boss registration', () => {
  it('@AC-1 schedules report.generate at 02:00 UTC and the alarm check at 07:30 UTC', async () => {
    const { boss, deps } = setup()
    await registerReportWorker(boss, deps)

    expect(GENERATE_CRON).toBe('0 2 * * *')
    expect(DEADLINE_CHECK_CRON).toBe('30 7 * * *')
    expect(boss.schedules).toEqual([
      { name: 'report.generate', cron: '0 2 * * *', data: {}, options: { tz: 'UTC' } },
      { name: 'report.deadline-check', cron: '30 7 * * *', data: {}, options: { tz: 'UTC' } },
    ])
    expect(boss.queues).toEqual([
      { name: GENERATE_QUEUE, policy: 'singleton', expireInSeconds: GENERATE_EXPIRE_SECONDS },
      { name: DEADLINE_CHECK_QUEUE },
    ])
    expect(GENERATE_EXPIRE_SECONDS).toBeGreaterThanOrEqual(5 * 3600)
  })

  it('@AC-1 the scheduled run reports yesterday and returns only the outcome kind', async () => {
    const { boss, deps, store } = setup()
    await registerReportWorker(boss, deps)

    const output = await boss.handlers.get(GENERATE_QUEUE)?.([{ id: 'job-1', data: {} }])

    expect(output).toEqual([{ kind: 'published' }])
    expect(store.listPublished().map((report) => report.reportDate)).toEqual(['2026-10-11'])
  })

  it('@AC-4 a re-run for a named date leaves the published report as it was', async () => {
    const { boss, deps, store } = setup()
    await registerReportWorker(boss, deps)
    const handler = boss.handlers.get(GENERATE_QUEUE) as Handler

    await handler([{ id: 'job-1', data: { reportDate: '2026-10-11' } }])
    const before = store.listPublished()
    const output = await handler([{ id: 'job-2', data: { reportDate: '2026-10-11' } }])

    expect(output).toEqual([{ kind: 'already-published' }])
    expect(store.listPublished()).toEqual(before)
  })

  it('@AC-6 the 07:30 job emits the alarm metric', async () => {
    const { boss, deps, clock, metrics } = setup()
    await registerReportWorker(boss, deps)
    clock.set('2026-10-12T07:30:00.000Z')

    const output = await boss.handlers.get(DEADLINE_CHECK_QUEUE)?.([{ id: 'job-3', data: {} }])

    expect(output).toEqual({ reportDate: '2026-10-11', missing: true })
    expect(metrics.last('CompleteReportMissing')?.value).toBe(1)
  })

  it('a failed run surfaces a fixed message without the sign-in id or UPN', async () => {
    const { boss, deps, store } = setup()
    store.publish = async () => {
      throw new Error('insert failed for sign-in sign-in-0004242 by alice@contoso.example')
    }
    await registerReportWorker(boss, deps)

    const failure = boss.handlers.get(GENERATE_QUEUE)?.([{ id: 'job-4', data: { reportDate: '2026-10-11' } }])

    await expect(failure).rejects.toThrow('report generation failed for 2026-10-11')
    const surfaced = await failure?.then(
      () => '',
      (problem: Error) => `${problem.message} ${String(problem.cause ?? '')} ${problem.stack ?? ''}`,
    )
    expect(surfaced).not.toContain('sign-in-0004242')
    expect(surfaced).not.toContain('alice@contoso.example')
  })

  it('a failed deadline check surfaces a fixed message without the original detail', async () => {
    const { boss, deps, clock, store } = setup()
    store.findPublished = async () => {
      throw new Error('lookup failed near sign-in-0004242 for alice@contoso.example')
    }
    await registerReportWorker(boss, deps)
    clock.set('2026-10-12T07:30:00.000Z')

    const failure = boss.handlers.get(DEADLINE_CHECK_QUEUE)?.([{ id: 'job-5', data: {} }])

    await expect(failure).rejects.toThrow('report deadline check failed for 2026-10-11')
    const surfaced = await failure?.then(
      () => '',
      (problem: Error) => `${problem.message} ${String(problem.cause ?? '')} ${problem.stack ?? ''}`,
    )
    expect(surfaced).not.toContain('sign-in-0004242')
    expect(surfaced).not.toContain('alice@contoso.example')
  })

  it('rejects a payload whose date is malformed', () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    expect(reportDateFor(null, clock)).toBe('2026-10-11')
    expect(reportDateFor({ reportDate: '2026-10-09' }, clock)).toBe('2026-10-09')
    expect(() => reportDateFor({ reportDate: "2026-10-09'; DROP TABLE report" }, clock)).toThrow('YYYY-MM-DD')
  })
})
