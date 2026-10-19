import { describe, expect, it } from 'vitest'
import {
  alarmCheckTime,
  isReportDate,
  previousUtcDay,
  publishDeadline,
  retryDeadline,
  windowContains,
  windowFor,
} from '../src/index.js'

describe('report window (AC-1, AC-2)', () => {
  it('covers 00:00 UTC of D up to but not including 00:00 UTC of D+1', () => {
    expect(windowFor('2026-10-11')).toEqual({ start: '2026-10-11T00:00:00.000Z', end: '2026-10-12T00:00:00.000Z' })
  })

  it('crosses month and year ends', () => {
    expect(windowFor('2026-10-31').end).toBe('2026-11-01T00:00:00.000Z')
    expect(windowFor('2026-12-31').end).toBe('2027-01-01T00:00:00.000Z')
    expect(windowFor('2028-02-28').end).toBe('2028-02-29T00:00:00.000Z')
  })

  it('includes 23:59:59.999 on D and excludes 00:00:00.000 on D+1', () => {
    const window = windowFor('2026-10-11')
    expect(windowContains(window, '2026-10-11T23:59:59.999Z')).toBe(true)
    expect(windowContains(window, '2026-10-12T00:00:00.000Z')).toBe(false)
  })

  it('includes 00:00:00.000 on D and excludes 23:59:59.999 on D-1', () => {
    const window = windowFor('2026-10-11')
    expect(windowContains(window, '2026-10-11T00:00:00.000Z')).toBe(true)
    expect(windowContains(window, '2026-10-10T23:59:59.999Z')).toBe(false)
  })

  it('treats Graph seven-digit fractions inside the last millisecond as on D', () => {
    expect(windowContains(windowFor('2026-10-11'), '2026-10-11T23:59:59.9999999Z')).toBe(true)
  })

  it('rejects an unparseable instant', () => {
    expect(windowContains(windowFor('2026-10-11'), 'not a time')).toBe(false)
  })
})

describe('report date from the schedule', () => {
  it('is the previous UTC day for the 02:00 UTC run', () => {
    expect(previousUtcDay(new Date('2026-10-12T02:00:00.000Z'))).toBe('2026-10-11')
  })

  it('is the previous UTC day at 00:00:00.000 and at 23:59:59.999', () => {
    expect(previousUtcDay(new Date('2026-10-12T00:00:00.000Z'))).toBe('2026-10-11')
    expect(previousUtcDay(new Date('2026-10-12T23:59:59.999Z'))).toBe('2026-10-11')
    expect(previousUtcDay(new Date('2026-10-11T23:59:59.999Z'))).toBe('2026-10-10')
  })

  it('accepts only real calendar dates in YYYY-MM-DD', () => {
    expect(isReportDate('2026-10-11')).toBe(true)
    expect(isReportDate('2028-02-29')).toBe(true)
    expect(isReportDate('2026-02-29')).toBe(false)
    expect(isReportDate('2026-13-01')).toBe(false)
    expect(isReportDate('2026-10-11T00:00:00Z')).toBe(false)
    expect(isReportDate(20261011)).toBe(false)
  })
})

describe('deadlines on D+1', () => {
  it('stops retrying at 07:00, checks for the alarm at 07:30 and publishes by 08:00 UTC', () => {
    expect(retryDeadline('2026-10-11').toISOString()).toBe('2026-10-12T07:00:00.000Z')
    expect(alarmCheckTime('2026-10-11').toISOString()).toBe('2026-10-12T07:30:00.000Z')
    expect(publishDeadline('2026-10-11').toISOString()).toBe('2026-10-12T08:00:00.000Z')
  })
})
