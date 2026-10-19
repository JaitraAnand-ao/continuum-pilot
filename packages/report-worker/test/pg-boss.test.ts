import { randomUUID } from 'node:crypto'
import PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createEmfMetricsSink,
  createPgReportStore,
  DEADLINE_CHECK_QUEUE,
  GENERATE_QUEUE,
  registerReportWorker,
} from '../src/index.js'
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

describe.skipIf(!databaseUrl)('report.deadline-check through pg-boss on PostgreSQL', () => {
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

  it('@AC-6 the 07:30 job completes and writes the alarm metric as an EMF line', async () => {
    const clock = new FakeClock('2026-10-12T07:30:00.000Z')
    const graph = new ScriptedGraph(clock, {})
    const lines: string[] = []
    await registerReportWorker(boss, {
      clock,
      sleeper: new FakeSleeper(clock),
      signIns: graph,
      risk: graph,
      store: createPgReportStore(database.db),
      metrics: createEmfMetricsSink((line) => lines.push(line), clock),
    })

    const id = (await boss.send(DEADLINE_CHECK_QUEUE, {})) as string
    let job = await boss.getJobById(DEADLINE_CHECK_QUEUE, id)
    for (let attempt = 0; attempt < 100 && !['completed', 'failed'].includes(job?.state ?? ''); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      job = await boss.getJobById(DEADLINE_CHECK_QUEUE, id)
    }

    expect(job?.state).toBe('completed')
    expect(lines).toHaveLength(1)
    const emitted = JSON.parse(lines[0] as string)
    expect(emitted._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: 'SigninReports/ReportWorker',
        Dimensions: [[]],
        Metrics: [{ Name: 'CompleteReportMissing', Unit: 'Count' }],
      },
    ])
    expect(emitted.CompleteReportMissing).toBe(1)
    expect(emitted.reportDate).toBe('2026-10-11')
  }, 30_000)
})

describe.skipIf(!databaseUrl)('a failed report.generate job through pg-boss on PostgreSQL', () => {
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

  it('stores only the fixed message as the job output, never the UPN or sign-in id the error quoted', async () => {
    const upn = 'leaky.user@contoso.example'
    const signInId = 'sign-in-7f3c2a91-leak'
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const graph = new ScriptedGraph(clock, {
      signIns: [signIn({ id: signInId, createdAt: '2026-10-11T08:00:00.000Z' })],
    })
    const store = createPgReportStore(database.db)
    await registerReportWorker(boss, {
      clock,
      sleeper: new FakeSleeper(clock),
      signIns: graph,
      risk: graph,
      metrics: new RecordingMetrics(),
      store: {
        findPublished: (reportDate) => store.findPublished(reportDate),
        recordNotGenerated: (...args) => store.recordNotGenerated(...args),
        publish: async () => {
          throw new Error(`duplicate key for ${upn} on sign-in ${signInId}`)
        },
      },
    })

    const id = (await boss.send(GENERATE_QUEUE, { reportDate: '2026-10-11' }, { retryLimit: 0 })) as string
    let job = await boss.getJobById(GENERATE_QUEUE, id)
    for (let attempt = 0; attempt < 100 && job?.state !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      job = await boss.getJobById(GENERATE_QUEUE, id)
    }

    expect(job?.state).toBe('failed')
    const output = JSON.stringify(job?.output)
    expect(output).toContain('report generation failed for 2026-10-11')
    expect(output).not.toContain(upn)
    expect(output).not.toContain(signInId)
  }, 30_000)
})
