import { describe, expect, it } from 'vitest'
import { alarmCheckAt, inWindow, previousUtcDay, publishDeadline, retryDeadline, windowFor } from '../src/index.js'

describe('report window (AC-1, AC-2)', () => {
  it('covers 00:00 UTC of D up to but not including 00:00 UTC of D+1', () => {
    const window = windowFor('2026-10-11')
    expect(window.start.toISOString()).toBe('2026-10-11T00:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-10-12T00:00:00.000Z')
  })

  it('includes 23:59:59.999 on D and excludes 00:00:00.000 on D+1', () => {
    const window = windowFor('2026-10-11')
    expect(inWindow(window, new Date('2026-10-11T23:59:59.999Z'))).toBe(true)
    expect(inWindow(window, new Date('2026-10-12T00:00:00.000Z'))).toBe(false)
  })

  it('includes 00:00:00.000 on D and excludes 23:59:59.999 on D-1', () => {
    const window = windowFor('2026-10-11')
    expect(inWindow(window, new Date('2026-10-11T00:00:00.000Z'))).toBe(true)
    expect(inWindow(window, new Date('2026-10-10T23:59:59.999Z'))).toBe(false)
  })

  it('crosses month and year ends', () => {
    expect(windowFor('2026-12-31').end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    expect(windowFor('2028-02-28').end.toISOString()).toBe('2028-02-29T00:00:00.000Z')
  })

  it('rejects anything that is not a real calendar date', () => {
    expect(() => windowFor('2026-10-1')).toThrow(/report date/)
    expect(() => windowFor('2026-02-30')).toThrow(/report date/)
    expect(() => windowFor('2026-10-11T00:00:00Z')).toThrow(/report date/)
  })

  it('names the previous UTC day as the report date', () => {
    expect(previousUtcDay(new Date('2026-10-12T02:00:00.000Z'))).toBe('2026-10-11')
    expect(previousUtcDay(new Date('2026-10-12T00:00:00.000Z'))).toBe('2026-10-11')
    expect(previousUtcDay(new Date('2026-10-11T23:59:59.999Z'))).toBe('2026-10-10')
    expect(previousUtcDay(new Date('2027-01-01T02:00:00.000Z'))).toBe('2026-12-31')
  })

  it('places the retry deadline, alarm check and publish deadline on D+1', () => {
    expect(retryDeadline('2026-10-11').toISOString()).toBe('2026-10-12T07:00:00.000Z')
    expect(alarmCheckAt('2026-10-11').toISOString()).toBe('2026-10-12T07:30:00.000Z')
    expect(publishDeadline('2026-10-11').toISOString()).toBe('2026-10-12T08:00:00.000Z')
  })
})
