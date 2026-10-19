import { describe, expect, it } from 'vitest'
import { ReportAlreadyPublishedError, createInMemoryReportStore, type NewReport } from '../src/index.js'

const report: NewReport = {
  reportDate: '2026-10-11',
  windowStart: '2026-10-11T00:00:00.000Z',
  windowEnd: '2026-10-12T00:00:00.000Z',
  publishedAt: '2026-10-12T02:01:00.000Z',
  complete: true,
  missingSources: [],
  totals: {
    total: 0,
    successful: 0,
    failed: 0,
    byType: { interactiveUser: 0, nonInteractiveUser: 0, servicePrincipal: 0, managedIdentity: 0 },
  },
  signIns: [],
  riskDetections: [],
  contentHash: 'a'.repeat(64),
}

describe('in-memory report store', () => {
  it('refuses a second publish for the same date', async () => {
    const store = createInMemoryReportStore()
    await store.publish(report)
    await expect(store.publish({ ...report, contentHash: 'b'.repeat(64) })).rejects.toBeInstanceOf(
      ReportAlreadyPublishedError,
    )
    expect((await store.findPublished('2026-10-11'))!.contentHash).toBe('a'.repeat(64))
  })

  it('hands out frozen copies so a published report cannot be altered', async () => {
    const store = createInMemoryReportStore()
    const stored = await store.publish(report)
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.totals)).toBe(true)
    expect(() => {
      ;(stored as { complete: boolean }).complete = false
    }).toThrow()
    expect((await store.findPublished('2026-10-11'))!.complete).toBe(true)
  })

  it('clears a not-generated record once the day is published', async () => {
    const store = createInMemoryReportStore()
    await store.recordNotGenerated({
      reportDate: '2026-10-11',
      recordedAt: '2026-10-12T07:00:00.000Z',
      missingSources: ['x'],
    })
    expect(await store.findNotGenerated('2026-10-11')).not.toBeNull()
    await store.publish(report)
    expect(await store.findNotGenerated('2026-10-11')).toBeNull()
    expect(await store.findNotGenerated('2026-10-10')).toBeNull()
  })

  it('lists reports in date order', async () => {
    const store = createInMemoryReportStore()
    await store.publish({ ...report, reportDate: '2026-10-12' })
    await store.publish(report)
    expect((await store.list()).map((r) => r.reportDate)).toEqual(['2026-10-11', '2026-10-12'])
  })
})
