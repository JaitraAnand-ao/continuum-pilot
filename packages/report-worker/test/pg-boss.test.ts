import { randomUUID } from 'node:crypto'
import PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgReportStore, GENERATE_QUEUE, registerReportWorker } from '../src/index.js'
import { FakeClock, FakeSleeper, RecordingMetrics, ScriptedGraph, signIn } from './support/fakes.js'
import { databaseUrl, reportSchema } from './support/postgres.js'

describe.skipIf(!databaseUrl)('report.generate through pg-boss on PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof reportSchema>>
  let boss: PgBoss
  const schema = `pgboss_${randomUUID().replaceAll('-', '')}`

  beforeAll(async () => {
    database = await reportSchema()
    boss = new PgBoss({ connectionString: databaseUrl as string, schema, supervise: false, schedule: false })
    boss.on('error', () => undefined)
    await boss.start()
  })
  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true })
    await database?.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await database?.drop()
  })

  async function finished(id: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = await boss.getJobById(GENERATE_QUEUE, id)
      if (job && ['completed', 'failed'].includes(job.state)) return job
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`job ${id} did not finish`)
  }

  it('@AC-1 @AC-4 a job publishes the day once, and a second job for the same day changes nothing', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const graph = new ScriptedGraph(clock, { signIns: [signIn({ createdAt: '2026-10-11T08:00:00.000Z' })] })
    const deps = {
      clock,
      sleeper: new FakeSleeper(clock),
      signIns: graph,
      risk: graph,
      metrics: new RecordingMetrics(),
    }
    /* pg-boss runs in its own schema; the report tables live in the suite's schema. */
    const scopedStore = createPgReportStore(database.db)
    await registerReportWorker(boss, { ...deps, store: scopedStore })

    const first = await finished((await boss.send(GENERATE_QUEUE, {})) as string)
    expect(first.state).toBe('completed')
    expect(first.output).toEqual({ value: [{ kind: 'published' }] })
    const published = await scopedStore.findPublished('2026-10-11')

    const second = await finished((await boss.send(GENERATE_QUEUE, { reportDate: '2026-10-11' })) as string)
    expect(second.output).toEqual({ value: [{ kind: 'already-published' }] })
    expect((await scopedStore.listPublished()).filter((report) => report.reportDate === '2026-10-11')).toEqual([
      published,
    ])
  }, 30_000)
})
