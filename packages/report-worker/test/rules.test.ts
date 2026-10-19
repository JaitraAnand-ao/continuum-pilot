import { describe, expect, it } from 'vitest'
import {
  alarmCheckTime,
  assessCompleteness,
  isInWindow,
  isReportable,
  parseReportDate,
  previousUtcDate,
  publishDeadline,
  reportWindow,
  retryDeadline,
  totalsOf,
} from '../src/index.js'
import { signIn } from './support/fakes.js'

describe('report window (AC-1, AC-2)', () => {
  const window = reportWindow('2026-10-11')

  it('covers 00:00 UTC of D up to 00:00 UTC of D+1', () => {
    expect(window.start.toISOString()).toBe('2026-10-11T00:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-10-12T00:00:00.000Z')
  })

  it('includes its first instant and excludes the one just before it', () => {
    expect(isInWindow('2026-10-11T00:00:00.000Z', window)).toBe(true)
    expect(isInWindow('2026-10-10T23:59:59.999Z', window)).toBe(false)
  })

  it('includes 23:59:59.999 on D and excludes 00:00:00.000 on D+1', () => {
    expect(isInWindow('2026-10-11T23:59:59.999Z', window)).toBe(true)
    expect(isInWindow('2026-10-12T00:00:00.000Z', window)).toBe(false)
  })

  it('spans a month and a year end', () => {
    expect(reportWindow('2026-10-31').end.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(reportWindow('2026-12-31').end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('report date', () => {
  it('is the previous UTC day for any instant of the run day', () => {
    expect(previousUtcDate(new Date('2026-10-12T00:00:00.000Z'))).toBe('2026-10-11')
    expect(previousUtcDate(new Date('2026-10-12T02:00:00.000Z'))).toBe('2026-10-11')
    expect(previousUtcDate(new Date('2026-10-12T23:59:59.999Z'))).toBe('2026-10-11')
    expect(previousUtcDate(new Date('2026-10-11T23:59:59.999Z'))).toBe('2026-10-10')
  })

  it('accepts only calendar dates written YYYY-MM-DD', () => {
    expect(parseReportDate('2026-10-11')).toBe('2026-10-11')
    expect(() => parseReportDate('2026-02-30')).toThrow('not a calendar date')
    expect(() => parseReportDate('2026-10-11T00:00:00Z')).toThrow('YYYY-MM-DD')
    expect(() => parseReportDate(20261011)).toThrow('YYYY-MM-DD')
  })

  it('is reportable from the first instant after the day ends, not one millisecond before', () => {
    expect(isReportable('2026-10-11', new Date('2026-10-12T00:00:00.000Z'))).toBe(true)
    expect(isReportable('2026-10-11', new Date('2026-10-11T23:59:59.999Z'))).toBe(false)
  })
})

describe('deadlines on D+1', () => {
  it('stops retrying at 07:00, checks the alarm at 07:30 and is due by 08:00 UTC', () => {
    expect(retryDeadline('2026-10-11').toISOString()).toBe('2026-10-12T07:00:00.000Z')
    expect(alarmCheckTime('2026-10-11').toISOString()).toBe('2026-10-12T07:30:00.000Z')
    expect(publishDeadline('2026-10-11').toISOString()).toBe('2026-10-12T08:00:00.000Z')
  })
})

describe('totals', () => {
  it('are zero for a day without sign-ins (AC-7)', () => {
    expect(totalsOf([])).toEqual({ total: 0, successful: 0, failed: 0 })
  })

  it('count error code 0 as successful and every other code as failed', () => {
    const signIns = [signIn({ errorCode: 0 }), signIn({ errorCode: 50126 }), signIn({ errorCode: 1 })]
    expect(totalsOf(signIns)).toEqual({ total: 3, successful: 1, failed: 2 })
  })
})

describe('completeness (AC-5)', () => {
  it('is complete only when no source is missing', () => {
    expect(assessCompleteness(0, 4, false)).toBe('complete')
    expect(assessCompleteness(0, 4, true)).toBe('incomplete')
    expect(assessCompleteness(3, 4, false)).toBe('incomplete')
  })

  it('is not generated when every sign-in type is missing', () => {
    expect(assessCompleteness(4, 4, false)).toBe('not-generated')
    expect(assessCompleteness(4, 4, true)).toBe('not-generated')
  })
})
