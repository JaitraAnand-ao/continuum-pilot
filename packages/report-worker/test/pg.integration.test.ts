import { randomUUID } from 'node:crypto'
import PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  contentHash,
  figuresOf,
  generateReport,
  PgReportStore,
  QUEUE_CHECK,
  QUEUE_GENERATE,
  snapshotHashInput,
  startReportWorker,
} from '../src/index.js'
import { FakeClock, FakeGraph, RecordingMetrics, riskDetection, riskyUser, signIn } from './support.js'

const databaseUrl = process.env.AGENTX_TEST_DATABASE_URL

/* The tables the store expects from CMP-5's migrations, created here in a throwaway schema. */
const FIXTURE_DDL = [
  `CREATE TABLE report (
     report_date date PRIMARY KEY,
     window_start timestamptz NOT NULL,
     window_end timestamptz NOT NULL,
     status text NOT NULL CHECK (status IN ('complete', 'incomplete')),
     missing_sources text[] NOT NULL,
     total integer NOT NULL,
     successful integer NOT NULL,
     failed integer NOT NULL,
     snapshot jsonb NOT NULL,
     content_hash text NOT NULL,
     published_at timestamptz NOT NULL
   )`,
  `CREATE TABLE report_not_generated (
     report_date date PRIMARY KEY,
     missing_sources text[] NOT NULL,
     recorded_at timestamptz NOT NULL
   )`,
]

describe.skipIf(!databaseUrl)('report worker on real Postgres', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const dataSchema = `rw_${suffix}`
  let boss: PgBoss
  let store: PgReportStore

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    url.searchParams.set('options', `-c search_path=${dataSchema}`)
    boss = new PgBoss({ connectionString: url.toString(), schema: `pgboss_${suffix}` })
    boss.on('error', () => undefined)
    await boss.start()
    const db = boss.getDb()
    await db.executeSql(`CREATE SCHEMA ${dataSchema}`, [])
    for (const ddl of FIXTURE_DDL) await db.executeSql(ddl, [])
    store = new PgReportStore(db)
  })

  afterAll(async () => {
    if (!boss) return
    const db = boss.getDb()
    await boss.stop({ graceful: false, wait: true })
    const cleanup = new PgBoss({ connectionString: databaseUrl! })
    await cleanup.start()
    await cleanup.getDb().executeSql(`DROP SCHEMA IF EXISTS ${dataSchema} CASCADE`, [])
    await cleanup.getDb().executeSql(`DROP SCHEMA IF EXISTS pgboss_${suffix} CASCADE`, [])
    await cleanup.stop({ graceful: false, wait: true })
    void db
  })

  it('publishes once, reads back byte-identical to what was hashed, and refuses a second report (AC-1, AC-4)', async () => {
    const graph = new FakeGraph(
      [
        signIn({ id: 'a', createdDateTime: '2026-10-11T23:59:59.999Z', errorCode: 50126 }),
        signIn({ id: 'b', signInEventType: 'managedIdentity', createdDateTime: '2026-10-11T00:00:00.000Z' }),
        signIn({ id: 'c', createdDateTime: '2026-10-12T00:00:00.000Z' }),
      ],
      [riskDetection({ id: 'r1' })],
    )
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const first = await generateReport('2026-10-11', { graph, store, metrics: new RecordingMetrics(), clock })
    if (first.kind !== 'published') throw new Error(`expected published, got ${first.kind}`)

    const stored = await store.findReport('2026-10-11')
    expect(stored).toEqual(first.report)
    expect(contentHash(snapshotHashInput(stored!))).toBe(first.report.contentHash)
    expect(stored!.signIns.map((s) => s.id).sort()).toEqual(['a', 'b'])
    expect(stored!.totals).toEqual({ total: 2, successful: 1, failed: 1 })

    clock.set('2026-10-12T06:00:00.000Z')
    const rerun = await generateReport('2026-10-11', { graph, store, metrics: new RecordingMetrics(), clock })
    expect(rerun.kind).toBe('already-published')

    const tamper = { ...first.report, contentHash: 'f'.repeat(64), publishedAt: '2026-10-12T06:00:00.000Z' }
    const result = await store.publish(tamper)
    expect(result.created).toBe(false)
    expect(result.report.contentHash).toBe(first.report.contentHash)

    const { rows } = await boss
      .getDb()
      .executeSql(`SELECT count(*)::int AS n, max(content_hash) AS hash FROM report WHERE report_date = $1`, [
        '2026-10-11',
      ])
    expect(rows[0]).toEqual({ n: 1, hash: first.report.contentHash })
  })

  it('stores the Daily report figures with the snapshot and reads them back byte-identical (ST-3 AC-1 to AC-5, AC-10)', async () => {
    const graph = new FakeGraph([
      signIn({ id: 'x1', createdDateTime: '2026-10-09T00:00:00.000Z', errorCode: 50126 }),
      signIn({ id: 'x2', createdDateTime: '2026-10-09T23:59:59.999Z', appId: 'app-wd', appDisplayName: 'Workday' }),
      signIn({
        id: 'x3',
        signInEventType: 'servicePrincipal',
        createdDateTime: '2026-10-09T12:00:00.000Z',
        errorCode: 53003,
      }),
      signIn({ id: 'x4', createdDateTime: '2026-10-10T00:00:00.000Z', errorCode: 50053 }),
    ])
    const clock = new FakeClock('2026-10-10T02:00:00.000Z')
    const published = await generateReport('2026-10-09', { graph, store, metrics: new RecordingMetrics(), clock })
    if (published.kind !== 'published') throw new Error(`expected published, got ${published.kind}`)

    const stored = await store.findReport('2026-10-09')
    expect(stored!.figures).toEqual(figuresOf(published.report.signIns))
    expect(stored!.figures.all.totals).toEqual({ total: 3, successful: 1, failed: 2 })
    expect(stored!.figures.managedIdentity.totals).toEqual({ total: 0, successful: 0, failed: 0 })
    expect(contentHash(snapshotHashInput(stored!))).toBe(published.report.contentHash)

    const { rows } = await boss
      .getDb()
      .executeSql(`SELECT snapshot -> 'figures' AS figures FROM report WHERE report_date = $1`, ['2026-10-09'])
    expect(canonicalJson(rows[0]!.figures)).toBe(canonicalJson(published.report.figures))
    const reread = await store.findReport('2026-10-09')
    expect(JSON.stringify(reread!.figures)).toBe(JSON.stringify(stored!.figures))
    expect(reread!.contentHash).toBe(published.report.contentHash)

    const late = new FakeGraph([signIn({ id: 'late', createdDateTime: '2026-10-09T18:00:00.000Z' })])
    clock.set('2026-10-10T09:00:00.000Z')
    await generateReport('2026-10-09', { graph: late, store, metrics: new RecordingMetrics(), clock })
    expect((await store.findReport('2026-10-09'))!.figures).toEqual(stored!.figures)
  })

  it('stores the risky users and the risk flags with the report and reads them back as hashed (ST-9 AC-1, AC-4, AC-5)', async () => {
    const graph = new FakeGraph(
      [
        signIn({
          id: 'si-chen',
          createdDateTime: '2026-10-03T10:00:00.000Z',
          userId: 'u-chen',
          riskLevelAggregated: 'high',
          location: null,
        }),
      ],
      [
        riskDetection({
          id: 'rd-1',
          userId: 'u-chen',
          riskLevel: 'high',
          detectedDateTime: '2026-10-03T09:00:00.000Z',
        }),
      ],
      1000,
      [riskyUser({ id: 'u-chen', riskState: 'confirmedCompromised', riskLevel: 'medium' })],
    )
    const outcome = await generateReport('2026-10-03', {
      graph,
      store,
      metrics: new RecordingMetrics(),
      clock: new FakeClock('2026-10-04T02:00:00.000Z'),
    })
    if (outcome.kind !== 'published') throw new Error(`expected published, got ${outcome.kind}`)

    const stored = await store.findReport('2026-10-03')
    expect(stored).toEqual(outcome.report)
    expect(contentHash(snapshotHashInput(stored!))).toBe(outcome.report.contentHash)
    expect(stored!.riskyUsers.map((user) => user.id)).toEqual(['u-chen'])
    if (!stored!.riskFlags.riskySignIns.evaluated || !stored!.riskFlags.riskyUsers.evaluated)
      throw new Error('expected both categories evaluated')
    expect(stored!.riskFlags.riskySignIns.flags[0]!.evidence.location).toBe('not recorded')
    expect(stored!.riskFlags.riskyUsers.flags[0]).toMatchObject({
      userId: 'u-chen',
      detections: [{ id: 'rd-1' }],
      signInIds: ['si-chen'],
    })
  })

  it('stores Identity Protection categories as not evaluated when it could not be read (ST-9 AC-7)', async () => {
    const graph = new FakeGraph([
      signIn({ id: 'a', createdDateTime: '2026-10-08T10:00:00.000Z', riskLevelAggregated: 'high' }),
    ])
    graph.failRisk = 'always'
    const outcome = await generateReport('2026-10-08', {
      graph,
      store,
      metrics: new RecordingMetrics(),
      clock: new FakeClock('2026-10-09T06:59:00.000Z'),
    })
    expect(outcome.kind).toBe('published')
    const stored = await store.findReport('2026-10-08')
    expect(stored!.status).toBe('incomplete')
    expect(stored!.riskFlags).toEqual({
      riskySignIns: { evaluated: false, missingSources: ['identityProtection.riskDetections'] },
      riskyUsers: { evaluated: false, missingSources: ['identityProtection.riskDetections'] },
    })
  })

  it('records a not-generated day and returns nothing for an unknown day (AC-5)', async () => {
    const graph = new FakeGraph()
    graph.failRisk = 'always'
    graph.failSignIns = 'always'
    const outcome = await generateReport('2026-10-05', {
      graph,
      store,
      metrics: new RecordingMetrics(),
      clock: new FakeClock('2026-10-06T06:59:00.000Z'),
    })
    expect(outcome.kind).toBe('not-generated')
    expect(await store.findReport('2026-10-05')).toBeUndefined()
    const day = await store.findNotGenerated('2026-10-05')
    expect(day).toEqual({
      reportDate: '2026-10-05',
      missingSources: [
        'signIns.interactiveUser',
        'signIns.nonInteractiveUser',
        'signIns.servicePrincipal',
        'signIns.managedIdentity',
        'identityProtection.riskDetections',
      ],
      recordedAt: expect.stringMatching(/^2026-10-06T06:59:\d\d\.\d{3}Z$/),
    })
    await store.recordNotGenerated({ ...day!, recordedAt: '2026-10-06T07:00:00.000Z' })
    expect((await store.findNotGenerated('2026-10-05'))!.recordedAt).toBe('2026-10-06T07:00:00.000Z')
    expect(await store.findNotGenerated('2026-10-04')).toBeUndefined()
  })

  it('a doubly delivered report.generate job through pg-boss leaves exactly one report, then report.check sees it', async () => {
    const metrics = new RecordingMetrics()
    const clock = new FakeClock('2026-10-08T02:00:00.000Z')
    await startReportWorker(boss, { graph: new FakeGraph([]), store, metrics, clock }, { pollingIntervalSeconds: 0.5 })

    const ids = await Promise.all([
      boss.send(QUEUE_GENERATE, { reportDate: '2026-10-07' }),
      boss.send(QUEUE_GENERATE, { reportDate: '2026-10-07' }),
    ])
    await waitForCompletion(boss, QUEUE_GENERATE, ids)

    const { rows } = await boss
      .getDb()
      .executeSql(`SELECT count(*)::int AS n FROM report WHERE report_date = $1`, ['2026-10-07'])
    expect(rows[0]).toEqual({ n: 1 })
    expect(metrics.emitted.filter((m) => m.name === 'ReportPublished')).toHaveLength(1)

    clock.set('2026-10-08T07:30:00.000Z')
    await waitForCompletion(boss, QUEUE_CHECK, [await boss.send(QUEUE_CHECK, {})])
    expect(metrics.emitted.at(-1)).toMatchObject({
      namespace: 'SigninReports',
      name: 'CompleteReportMissing',
      value: 0,
    })
  }, 30_000)
})

async function waitForCompletion(boss: PgBoss, queue: string, ids: (string | null)[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const jobs = await Promise.all(ids.map((id) => boss.getJobById(queue, id!)))
    if (jobs.some((job) => job?.state === 'failed')) throw new Error(`a ${queue} job failed`)
    if (jobs.every((job) => job?.state === 'completed')) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`${queue} jobs did not complete`)
}

/* Key-sorted JSON: jsonb reorders object keys, so byte-identity is compared on the canonical form. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
