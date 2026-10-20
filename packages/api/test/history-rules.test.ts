/* The ST-7 history rules on an injected instant: the 90-day range, on-time versus late, when a missing day counts as
 * not generated, the first report's due time, and the Month and Status filters (AC-1, AC-3, AC-4, AC-5). */
import { describe, expect, it } from 'vitest'
import {
  buildHistory,
  filterHistory,
  firstFullDay,
  historyRange,
  HISTORY_DAYS,
  onTimeUntil,
  reportDueAt,
  reportStatus,
  type StoredReportSummary,
} from '../src/history/rules.js'

const at = (iso: string) => new Date(iso)
const report = (reportDate: string, publishedAt: string, total = 100, failed = 7): StoredReportSummary => ({
  reportDate,
  publishedAt,
  total,
  failed,
})
const NO_ROWS = { reports: [], notGenerated: [] }
const STARTED_LONG_AGO = at('2026-01-01T00:00:00.000Z')

describe('historyRange', () => {
  it('covers the 90 UTC days before today, ending yesterday', () => {
    expect(HISTORY_DAYS).toBe(90)
    expect(historyRange(at('2026-10-20T12:00:00.000Z'))).toEqual({ from: '2026-07-22', to: '2026-10-19' })
  })

  it('moves at 00:00:00.000 UTC and not one millisecond before', () => {
    expect(historyRange(at('2026-10-20T23:59:59.999Z'))).toEqual({ from: '2026-07-22', to: '2026-10-19' })
    expect(historyRange(at('2026-10-21T00:00:00.000Z'))).toEqual({ from: '2026-07-23', to: '2026-10-20' })
  })

  it('crosses a year end', () => {
    expect(historyRange(at('2027-01-01T08:00:00.000Z'))).toEqual({ from: '2026-10-03', to: '2026-12-31' })
  })
})

describe('firstFullDay', () => {
  it('is the start day when collection starts exactly at 00:00:00.000 UTC', () => {
    expect(firstFullDay(at('2026-10-20T00:00:00.000Z'))).toBe('2026-10-20')
  })

  it('is the next day when collection starts one millisecond later, or at 23:59:59.999', () => {
    expect(firstFullDay(at('2026-10-20T00:00:00.001Z'))).toBe('2026-10-21')
    expect(firstFullDay(at('2026-10-20T23:59:59.999Z'))).toBe('2026-10-21')
    expect(firstFullDay(at('2026-12-31T10:00:00.000Z'))).toBe('2027-01-01')
  })
})

describe('reportDueAt and onTimeUntil', () => {
  it('a report for D is due by 08:00 UTC on D+1 and on time until the 07:30 UTC check', () => {
    expect(reportDueAt('2026-10-11').toISOString()).toBe('2026-10-12T08:00:00.000Z')
    expect(onTimeUntil('2026-10-11').toISOString()).toBe('2026-10-12T07:30:00.000Z')
    expect(reportDueAt('2026-12-31').toISOString()).toBe('2027-01-01T08:00:00.000Z')
  })
})

describe('reportStatus', () => {
  it('is available when published by 07:30:00.000 UTC on D+1, and one millisecond before', () => {
    expect(reportStatus(report('2026-10-11', '2026-10-12T02:04:00.000Z'))).toBe('available')
    expect(reportStatus(report('2026-10-11', '2026-10-12T07:29:59.999Z'))).toBe('available')
    expect(reportStatus(report('2026-10-11', '2026-10-12T07:30:00.000Z'))).toBe('available')
  })

  it('is generated late one millisecond after 07:30 UTC, at 07:42, and on any later day', () => {
    expect(reportStatus(report('2026-10-11', '2026-10-12T07:30:00.001Z'))).toBe('generated_late')
    expect(reportStatus(report('2026-10-11', '2026-10-12T07:42:00.000Z'))).toBe('generated_late')
    expect(reportStatus(report('2026-10-11', '2026-10-14T03:00:00.000Z'))).toBe('generated_late')
  })
})

describe('buildHistory', () => {
  const now = at('2026-10-20T09:00:00.000Z')

  it('lists every day of the range newest first, the stored figures unchanged and no flag or email yet (AC-1)', () => {
    const stored = {
      reports: [
        report('2026-10-19', '2026-10-20T02:03:04.567Z', 1234, 56),
        report('2026-10-07', '2026-10-08T07:42:00.000Z', 900, 0),
      ],
      notGenerated: ['2026-10-06'],
    }
    const history = buildHistory(stored, STARTED_LONG_AGO, now)
    expect(history.totalDays).toBe(90)
    expect(history.items).toHaveLength(90)
    expect(history.firstReportDueAt).toBeNull()
    expect(history.items[0]).toEqual({
      reportDate: '2026-10-19',
      status: 'available',
      generatedAt: '2026-10-20T02:03:04.567Z',
      signIns: 1234,
      failed: 56,
      flagCount: null,
      emailedAt: null,
    })
    expect(history.items.at(-1)!.reportDate).toBe('2026-07-22')
    const byDate = new Map(history.items.map((item) => [item.reportDate, item]))
    expect(byDate.get('2026-10-07')).toMatchObject({
      status: 'generated_late',
      generatedAt: '2026-10-08T07:42:00.000Z',
      signIns: 900,
      failed: 0,
    })
    expect(byDate.get('2026-10-06')).toEqual({
      reportDate: '2026-10-06',
      status: 'not_generated',
      generatedAt: null,
      signIns: null,
      failed: null,
      flagCount: null,
      emailedAt: null,
    })
    const dates = history.items.map((item) => item.reportDate)
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  it('counts a day with no stored row as not generated from 08:00:00.000 UTC on D+1, and omits it one millisecond before', () => {
    expect(buildHistory(NO_ROWS, STARTED_LONG_AGO, at('2026-10-20T07:59:59.999Z')).items[0]!.reportDate).toBe(
      '2026-10-18',
    )
    const due = buildHistory(NO_ROWS, STARTED_LONG_AGO, at('2026-10-20T08:00:00.000Z'))
    expect(due.items[0]).toMatchObject({ reportDate: '2026-10-19', status: 'not_generated' })
    expect(due.totalDays).toBe(90)
  })

  it('lists yesterday before 08:00 UTC once its report or not-generated record is stored', () => {
    const early = at('2026-10-20T07:10:00.000Z')
    const published = buildHistory(
      { reports: [report('2026-10-19', '2026-10-20T02:30:00.000Z')], notGenerated: [] },
      STARTED_LONG_AGO,
      early,
    )
    expect(published.items[0]).toMatchObject({ reportDate: '2026-10-19', status: 'available' })
    const failed = buildHistory({ reports: [], notGenerated: ['2026-10-19'] }, STARTED_LONG_AGO, early)
    expect(failed.items[0]).toMatchObject({ reportDate: '2026-10-19', status: 'not_generated' })
  })

  it('prefers a stored report over a not-generated record for the same day', () => {
    const history = buildHistory(
      { reports: [report('2026-10-10', '2026-10-12T09:00:00.000Z')], notGenerated: ['2026-10-10'] },
      STARTED_LONG_AGO,
      now,
    )
    expect(history.items.filter((item) => item.reportDate === '2026-10-10')).toEqual([
      expect.objectContaining({ status: 'generated_late' }),
    ])
  })

  it('ignores rows outside the range: day 90 is listed, day 91 is not', () => {
    const history = buildHistory(
      {
        reports: [report('2026-07-22', '2026-07-23T02:00:00.000Z'), report('2026-07-21', '2026-07-22T02:00:00.000Z')],
        notGenerated: ['2026-10-20'],
      },
      STARTED_LONG_AGO,
      now,
    )
    const dates = history.items.map((item) => item.reportDate)
    expect(dates).toContain('2026-07-22')
    expect(dates).not.toContain('2026-07-21')
    expect(dates).not.toContain('2026-10-20')
    expect(history.totalDays).toBe(90)
  })

  it('does not list days before the first full UTC day of collection as not generated', () => {
    const history = buildHistory(NO_ROWS, at('2026-10-15T00:00:00.001Z'), now)
    expect(history.items.map((item) => item.reportDate)).toEqual([
      '2026-10-19',
      '2026-10-18',
      '2026-10-17',
      '2026-10-16',
    ])
    expect(buildHistory(NO_ROWS, at('2026-10-15T00:00:00.000Z'), now).items.at(-1)!.reportDate).toBe('2026-10-15')
  })

  it('before the first report, gives no day and when the first one is due (AC-5)', () => {
    const history = buildHistory(NO_ROWS, at('2026-10-20T06:00:00.000Z'), now)
    expect(history).toEqual({ items: [], totalDays: 0, firstReportDueAt: '2026-10-22T08:00:00.000Z' })
  })

  it('while only not-generated days exist, gives the next due time still ahead, and none once a report exists', () => {
    const started = at('2026-10-17T11:00:00.000Z')
    const notGeneratedOnly = { reports: [], notGenerated: ['2026-10-18'] }
    const failing = buildHistory(notGeneratedOnly, started, now)
    expect(failing.firstReportDueAt).toBe('2026-10-21T08:00:00.000Z')
    expect(buildHistory(notGeneratedOnly, started, at('2026-10-20T07:59:59.999Z')).firstReportDueAt).toBe(
      '2026-10-20T08:00:00.000Z',
    )
    expect(buildHistory(notGeneratedOnly, started, at('2026-10-20T08:00:00.000Z')).firstReportDueAt).toBe(
      '2026-10-21T08:00:00.000Z',
    )
    expect(failing.items.map((item) => item.status)).toEqual(['not_generated', 'not_generated'])
    const published = buildHistory(
      { reports: [report('2026-10-19', '2026-10-20T02:00:00.000Z')], notGenerated: ['2026-10-18'] },
      started,
      now,
    )
    expect(published.firstReportDueAt).toBeNull()
  })

  it('never gives a due time in the past when collection started long ago and no report is in the range', () => {
    const history = buildHistory(NO_ROWS, STARTED_LONG_AGO, now)
    expect(history.totalDays).toBe(90)
    expect(history.firstReportDueAt).toBe('2026-10-21T08:00:00.000Z')
  })

  it('normalises a stored instant to ISO 8601 UTC and refuses an unreadable one', () => {
    const offset = buildHistory(
      { reports: [report('2026-10-19', '2026-10-20T04:00:00+02:00')], notGenerated: [] },
      STARTED_LONG_AGO,
      now,
    )
    expect(offset.items[0]).toMatchObject({ status: 'available', generatedAt: '2026-10-20T02:00:00.000Z' })
    expect(() =>
      buildHistory({ reports: [report('2026-10-19', 'garbage')], notGenerated: [] }, STARTED_LONG_AGO, now),
    ).toThrow(RangeError)
  })

  it('lists only stored days, and no due time, when collection has not started', () => {
    expect(buildHistory(NO_ROWS, null, now)).toEqual({ items: [], totalDays: 0, firstReportDueAt: null })
    const history = buildHistory(
      { reports: [report('2026-10-12', '2026-10-13T02:00:00.000Z')], notGenerated: [] },
      null,
      now,
    )
    expect(history.items.map((item) => item.reportDate)).toEqual(['2026-10-12'])
    expect(history.firstReportDueAt).toBeNull()
  })
})

describe('filterHistory', () => {
  const now = at('2026-11-01T09:00:00.000Z')
  const history = buildHistory(
    {
      reports: [
        report('2026-10-31', '2026-11-01T02:00:00.000Z'),
        report('2026-10-07', '2026-10-08T07:42:00.000Z'),
        report('2026-10-01', '2026-10-02T02:00:00.000Z'),
        report('2026-09-30', '2026-10-01T02:00:00.000Z'),
      ],
      notGenerated: ['2026-10-06'],
    },
    STARTED_LONG_AGO,
    now,
  )

  it('returns everything with no filter', () => {
    expect(filterHistory(history, {})).toEqual(history)
  })

  it('narrows to one UTC month, first and last day included, keeping the unfiltered total (AC-3)', () => {
    const october = filterHistory(history, { month: '2026-10' })
    expect(october.items).toHaveLength(31)
    expect(october.items[0]!.reportDate).toBe('2026-10-31')
    expect(october.items.at(-1)!.reportDate).toBe('2026-10-01')
    expect(october.totalDays).toBe(90)
  })

  it('narrows to one status (AC-3)', () => {
    expect(filterHistory(history, { status: 'generated_late' }).items.map((item) => item.reportDate)).toEqual([
      '2026-10-07',
    ])
  })

  it('combines month and status, and can match no day (AC-4)', () => {
    const september = filterHistory(history, { month: '2026-09', status: 'available' })
    expect(september.items.map((item) => item.reportDate)).toEqual(['2026-09-30'])
    const none = filterHistory(history, { month: '2026-09', status: 'generated_late' })
    expect(none.items).toEqual([])
    expect(none.totalDays).toBe(90)
  })

  it('matches no day for a month outside the range', () => {
    expect(filterHistory(history, { month: '2025-10' }).items).toEqual([])
  })
})
