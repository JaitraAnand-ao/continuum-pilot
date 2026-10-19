import { describe, expect, it } from 'vitest'
import { createPgReportStore, type Db, type ReportDraft } from '../src/index.js'
import { riskDetection, signIn } from './support/fakes.js'

const row = {
  id: '6f1c2a54-0000-4000-8000-000000000001',
  report_date: '2026-10-11',
  window_start: new Date('2026-10-11T00:00:00.000Z'),
  window_end: new Date('2026-10-12T00:00:00.000Z'),
  complete: false,
  missing_sources: ['Identity Protection risk data'],
  total_count: 2,
  successful_count: 1,
  failed_count: 1,
  content_hash: 'a'.repeat(64),
  published_at: new Date('2026-10-12T02:03:04.005Z'),
}

const report = {
  id: row.id,
  reportDate: '2026-10-11',
  windowStart: '2026-10-11T00:00:00.000Z',
  windowEnd: '2026-10-12T00:00:00.000Z',
  complete: false,
  missingSources: ['Identity Protection risk data'],
  totals: { total: 2, successful: 1, failed: 1 },
  contentHash: 'a'.repeat(64),
  publishedAt: '2026-10-12T02:03:04.005Z',
}

/* Answers each statement with the next scripted rows and records what was bound. */
function scriptedDb(...answers: Record<string, unknown>[][]) {
  const statements: { text: string; values: unknown[] }[] = []
  const db: Db = {
    async executeSql(text, values) {
      statements.push({ text, values })
      return { rows: answers.shift() ?? [] }
    },
  }
  return { db, statements }
}

const draft: ReportDraft = {
  reportDate: '2026-10-11',
  windowStart: '2026-10-11T00:00:00.000Z',
  windowEnd: '2026-10-12T00:00:00.000Z',
  complete: false,
  missingSources: ['Identity Protection risk data'],
  totals: { total: 2, successful: 1, failed: 1 },
  contentHash: 'a'.repeat(64),
  signIns: [signIn(), signIn({ errorCode: 50126 })],
  riskDetections: [riskDetection()],
}

describe('PostgreSQL report store, statement by statement', () => {
  it('maps a stored row to a published report', async () => {
    const { db, statements } = scriptedDb([row])
    expect(await createPgReportStore(db).findPublished('2026-10-11')).toEqual(report)
    expect(statements[0]?.values).toEqual(['2026-10-11'])
  })

  it('finds nothing for a day without a report', async () => {
    const { db } = scriptedDb([])
    expect(await createPgReportStore(db).findPublished('2026-10-11')).toBeUndefined()
  })

  it('@AC-4 publishes header and snapshot in one statement that never overwrites', async () => {
    const { db, statements } = scriptedDb([row])
    const result = await createPgReportStore(db).publish(draft, new Date('2026-10-12T02:03:04.005Z'))

    expect(result).toEqual({ report, created: true })
    expect(statements).toHaveLength(1)
    expect(statements[0]?.text).toContain('ON CONFLICT (report_date) DO NOTHING')
    expect(statements[0]?.text).not.toMatch(/\bUPDATE\b|\bDELETE\b/)
    expect(statements[0]?.values).toEqual([
      '2026-10-11',
      '2026-10-11T00:00:00.000Z',
      '2026-10-12T00:00:00.000Z',
      false,
      ['Identity Protection risk data'],
      2,
      1,
      1,
      'a'.repeat(64),
      '2026-10-12T02:03:04.005Z',
      JSON.stringify(draft.signIns),
      JSON.stringify(draft.riskDetections),
    ])
  })

  it('@AC-4 returns the report already published when it loses the race', async () => {
    const { db, statements } = scriptedDb([], [row])
    const result = await createPgReportStore(db).publish(draft, new Date('2026-10-12T02:03:04.005Z'))
    expect(result).toEqual({ report, created: false })
    expect(statements).toHaveLength(2)
  })

  it('@AC-5 records a day not generated without overwriting an earlier record', async () => {
    const { db, statements } = scriptedDb([])
    await createPgReportStore(db).recordNotGenerated(
      '2026-10-11',
      ['Interactive user sign-ins'],
      new Date('2026-10-12T07:00:00.000Z'),
    )
    expect(statements[0]?.text).toContain('ON CONFLICT (report_date) DO NOTHING')
    expect(statements[0]?.values).toEqual(['2026-10-11', ['Interactive user sign-ins'], '2026-10-12T07:00:00.000Z'])
  })

  it('reads reports, snapshots and not-generated days back from bound parameters only', async () => {
    const stored = signIn()
    const risk = riskDetection()
    const { db, statements } = scriptedDb([row], [{ record: stored }], [{ record: risk }], [{ '?column?': 1 }], [])
    const store = createPgReportStore(db)

    expect(await store.listPublished()).toEqual([report])
    expect(await store.loadSnapshot(row.id)).toEqual({ signIns: [stored], riskDetections: [risk] })
    expect(await store.isRecordedNotGenerated('2026-10-11')).toBe(true)
    expect(await store.isRecordedNotGenerated('2026-10-12')).toBe(false)
    for (const statement of statements) expect(statement.text).not.toContain('2026-10-1')
  })
})
