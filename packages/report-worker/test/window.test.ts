import { describe, expect, it } from 'vitest'
import {
  collectionDeadline,
  completeReportDueAt,
  isWithinWindow,
  parseReportDate,
  previousUtcDate,
  publishDeadline,
  reportWindow,
  retryDeadline,
} from '../src/index.js'

describe('report window (AC-1)', () => {
  it('covers 00:00 UTC of D up to but not including 00:00 UTC of D+1', () => {
    expect(reportWindow('2026-10-11')).toEqual({
      reportDate: '2026-10-11',
      start: '2026-10-11T00:00:00Z',
      end: '2026-10-12T00:00:00Z',
    })
  })

  it('crosses month and year ends and leap days', () => {
    expect(reportWindow('2026-10-31').end).toBe('2026-11-01T00:00:00Z')
    expect(reportWindow('2026-12-31').end).toBe('2027-01-01T00:00:00Z')
    expect(reportWindow('2028-02-28').end).toBe('2028-02-29T00:00:00Z')
  })

  it('rejects dates that are not real calendar days', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-01', '20261011', '', '2026-10-11T00:00:00Z']) {
      expect(() => parseReportDate(bad), bad).toThrow(RangeError)
    }
    expect(parseReportDate('2028-02-29')).toBe('2028-02-29')
  })
})

describe('window boundaries are exact (AC-2)', () => {
  const window = reportWindow('2026-10-11')

  it('includes 23:59:59.999 on D and excludes 00:00:00.000 on D+1', () => {
    expect(isWithinWindow(window, '2026-10-11T23:59:59.999Z')).toBe(true)
    expect(isWithinWindow(window, '2026-10-12T00:00:00.000Z')).toBe(false)
  })

  it('includes 00:00:00.000 on D and excludes the millisecond before it', () => {
    expect(isWithinWindow(window, '2026-10-11T00:00:00.000Z')).toBe(true)
    expect(isWithinWindow(window, '2026-10-10T23:59:59.999Z')).toBe(false)
  })

  it('reads Graph seven-digit fractions and offsets by the instant they denote', () => {
    expect(isWithinWindow(window, '2026-10-11T23:59:59.9999999Z')).toBe(true)
    expect(isWithinWindow(window, '2026-10-12T01:59:59.999+02:00')).toBe(true)
    expect(isWithinWindow(window, '2026-10-12T02:00:00.000+02:00')).toBe(false)
  })

  it('refuses a timestamp it cannot read rather than guessing', () => {
    expect(() => isWithinWindow(window, 'yesterday')).toThrow(RangeError)
    expect(() => isWithinWindow(window, '2026-10-11')).toThrow(RangeError)
  })
})

describe('the daily timetable', () => {
  it('reports on the previous UTC day', () => {
    expect(previousUtcDate(new Date('2026-10-12T02:00:00Z'))).toBe('2026-10-11')
    expect(previousUtcDate(new Date('2026-10-12T00:00:00.000Z'))).toBe('2026-10-11')
    expect(previousUtcDate(new Date('2026-10-11T23:59:59.999Z'))).toBe('2026-10-10')
    expect(previousUtcDate(new Date('2027-01-01T02:00:00Z'))).toBe('2026-12-31')
  })

  it('stops retrying at 07:00, alarms at 07:30 and must publish by 08:00 UTC on D+1', () => {
    expect(retryDeadline('2026-10-11').toISOString()).toBe('2026-10-12T07:00:00.000Z')
    expect(completeReportDueAt('2026-10-11').toISOString()).toBe('2026-10-12T07:30:00.000Z')
    expect(publishDeadline('2026-10-11').toISOString()).toBe('2026-10-12T08:00:00.000Z')
  })

  it('collects until 07:00 UTC when started before it, and for thirty minutes when started at or after it', () => {
    const at = (iso: string) => collectionDeadline('2026-10-11', new Date(iso)).toISOString()
    expect(at('2026-10-12T02:00:00.000Z')).toBe('2026-10-12T07:00:00.000Z')
    expect(at('2026-10-12T06:59:59.999Z')).toBe('2026-10-12T07:00:00.000Z')
    expect(at('2026-10-12T07:00:00.000Z')).toBe('2026-10-12T07:30:00.000Z')
    expect(at('2026-10-19T09:00:00.000Z')).toBe('2026-10-19T09:30:00.000Z')
  })
})
