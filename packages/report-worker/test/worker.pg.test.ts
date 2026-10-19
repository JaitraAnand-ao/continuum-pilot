/* Integration on real Postgres through pg-boss: the queue configuration, the schedules and
 * idempotent re-delivery of report.generate. Skips cleanly where CI provides no database. */
import PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEADLINE_CHECK_CRON,
  REPORT_DEADLINE_CHECK_QUEUE,
  REPORT_GENERATE_CRON,
  REPORT_GENERATE_QUEUE,
  requestReport,
  startReportWorker,
} from '../src/index.js'
import { FakeClock, FakeGraph, MemoryMetrics, MemoryStore, signIn } from './support/fakes.js'

const connectionString = process.env.AGENTX_TEST_DATABASE_URL
const schema = `report_worker_test_${process.pid}`

async function settled(boss: PgBoss, id: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await boss.getJobById(REPORT_GENERATE_QUEUE, id, { includeArchive: true })
    if (job && ['completed', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`job ${id} did not settle`)
}

describe.skipIf(!connectionString)('report worker on pg-boss and Postgres', () => {
  let boss: PgBoss
  const clock = new FakeClock('2026-10-12T02:00:00Z')
  const graph = new FakeGraph(clock)
  const store = new MemoryStore()
  const metrics = new MemoryMetrics()

  beforeAll(async () => {
    boss = new PgBoss({ connectionString, schema, supervise: false, schedule: false })
    boss.on('error', () => undefined)
    await boss.start()
    graph.addSignIns(signIn('s1', '2026-10-11T12:00:00Z', 'interactiveUser'))
    const deps = { clock, sleeper: clock, graph, store, metrics }
    await startReportWorker(boss, deps, { pollingIntervalSeconds: 0.5 })
    /* Starting twice, as a restarted task does, must not fail on the existing queues. */
    await startReportWorker(boss, deps, { pollingIntervalSeconds: 0.5 })
  })

  afterAll(async () => {
    if (!boss) return
    await boss.stop({ graceful: false, wait: true })
    const cleanup = new PgBoss({ connectionString, schema, supervise: false, schedule: false })
    await cleanup.start()
    await cleanup.getDb().executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, [])
    await cleanup.stop({ graceful: false, wait: true })
  })

  it('creates singleton queues with the generate job allowed to run until 08:00', async () => {
    const generate = await boss.getQueue(REPORT_GENERATE_QUEUE)
    const check = await boss.getQueue(REPORT_DEADLINE_CHECK_QUEUE)
    expect(generate).toMatchObject({ name: REPORT_GENERATE_QUEUE, policy: 'singleton' })
    expect(check).toMatchObject({ name: REPORT_DEADLINE_CHECK_QUEUE, policy: 'singleton' })
  })

  it('stores both schedules in UTC', async () => {
    const schedules = await boss.getSchedules()
    expect(
      schedules
        .map(({ name, cron, timezone }) => ({ name, cron, timezone }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: REPORT_DEADLINE_CHECK_QUEUE, cron: DEADLINE_CHECK_CRON, timezone: 'UTC' },
      { name: REPORT_GENERATE_QUEUE, cron: REPORT_GENERATE_CRON, timezone: 'UTC' },
    ])
  })

  it('AC-4: delivering report.generate for the same date again leaves one unchanged report', async () => {
    const firstId = await requestReport(boss, '2026-10-11')
    expect(firstId).toEqual(expect.any(String))
    expect((await settled(boss, firstId ?? '')).state).toBe('completed')
    const before = structuredClone(store.published.get('2026-10-11'))

    graph.addSignIns(signIn('s2', '2026-10-11T13:00:00Z', 'interactiveUser'))
    const secondId = await requestReport(boss, '2026-10-11')
    expect((await settled(boss, secondId ?? '')).state).toBe('completed')

    expect(store.published.size).toBe(1)
    expect(store.published.get('2026-10-11')?.contentHash).toBe(before?.contentHash)
    expect(store.published.get('2026-10-11')).toEqual(before)
    expect(store.publishCalls).toBe(1)
  })
})
