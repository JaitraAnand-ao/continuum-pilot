/* ST-15 rules, pure: what counts as a valid threshold, what is stricter (applies at once) and what loosens (ST-16),
 * how a change becomes a new config version, and which report it applies from. Each boundary is tested at and one below. */
import { describe, expect, it } from 'vitest'
import {
  classifyThresholdChange,
  COUNT_MESSAGE,
  DEFAULT_THRESHOLDS,
  initialVersion,
  isSensitive,
  MAX_WINDOW_MINUTES,
  reportDateFor,
  validateThreshold,
  WINDOW_MESSAGE,
  withSensitiveApp,
  withThreshold,
} from '../src/settings/rules.js'

const SEEDED = new Date('2026-10-01T00:00:00.000Z')
const NOW = new Date('2026-10-12T09:30:00.000Z')

describe('defaults (AC-2)', () => {
  it('reads 10 failed sign-ins within 1 hour and 10 distinct users within 1 hour', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      repeated_failures: { count: 10, windowMinutes: 60 },
      password_spray: { count: 10, windowMinutes: 60 },
    })
  })

  it('seeds a first version in effect since it was created, with no sensitive apps', () => {
    const version = initialVersion('v0', SEEDED)
    expect(version).toEqual({
      id: 'v0',
      previousId: null,
      createdAt: SEEDED,
      createdBy: null,
      thresholds: {
        repeated_failures: { count: 10, windowMinutes: 60, inEffectSince: SEEDED },
        password_spray: { count: 10, windowMinutes: 60, inEffectSince: SEEDED },
      },
      sensitiveApps: [],
    })
  })
})

describe('validateThreshold (AC-5)', () => {
  it('accepts a count of 1, the smallest whole number allowed', () => {
    expect(validateThreshold({ count: 1, windowMinutes: 60 })).toEqual({
      ok: true,
      threshold: { count: 1, windowMinutes: 60 },
    })
  })

  it.each([0, -1, 1.5, 0.999, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '8', null])(
    'refuses a count of %s with the whole-number message',
    (count) => {
      expect(validateThreshold({ count, windowMinutes: 60 })).toEqual({
        ok: false,
        field: 'count',
        message: COUNT_MESSAGE,
      })
    },
  )

  it('reads exactly the message the story names', () => {
    expect(COUNT_MESSAGE).toBe('Enter a whole number of 1 or more')
  })

  it('accepts a window of 1 minute and of a full day', () => {
    expect(validateThreshold({ count: 5, windowMinutes: 1 }).ok).toBe(true)
    expect(validateThreshold({ count: 5, windowMinutes: MAX_WINDOW_MINUTES }).ok).toBe(true)
    expect(MAX_WINDOW_MINUTES).toBe(1440)
  })

  it.each([0, MAX_WINDOW_MINUTES + 1, 30.5, '60'])('refuses a window of %s', (windowMinutes) => {
    expect(validateThreshold({ count: 5, windowMinutes })).toEqual({
      ok: false,
      field: 'windowMinutes',
      message: WINDOW_MESSAGE,
    })
  })

  it('reports the count first when both are wrong', () => {
    expect(validateThreshold({ count: 0, windowMinutes: 0 })).toMatchObject({ field: 'count' })
  })
})

describe('classifyThresholdChange (AC-3)', () => {
  const current = { count: 10, windowMinutes: 60 }

  it('a count one lower tightens', () => {
    expect(classifyThresholdChange(current, { count: 9, windowMinutes: 60 })).toBe('tighten')
  })

  it('a window one minute wider tightens', () => {
    expect(classifyThresholdChange(current, { count: 10, windowMinutes: 61 })).toBe('tighten')
  })

  it('lowering the count and widening the window together tightens', () => {
    expect(classifyThresholdChange(current, { count: 8, windowMinutes: 120 })).toBe('tighten')
  })

  it('the same count and window is unchanged', () => {
    expect(classifyThresholdChange(current, { count: 10, windowMinutes: 60 })).toBe('unchanged')
  })

  it('a count one higher loosens', () => {
    expect(classifyThresholdChange(current, { count: 11, windowMinutes: 60 })).toBe('loosen')
  })

  it('a window one minute narrower loosens', () => {
    expect(classifyThresholdChange(current, { count: 10, windowMinutes: 59 })).toBe('loosen')
  })

  it('a lower count with a narrower window loosens, because one half needs approval', () => {
    expect(classifyThresholdChange(current, { count: 5, windowMinutes: 30 })).toBe('loosen')
  })
})

describe('withThreshold (AC-3)', () => {
  it('makes a new version chained to the old one, restarting only the changed threshold’s in-effect date', () => {
    const before = initialVersion('v0', SEEDED)
    const after = withThreshold(
      before,
      'repeated_failures',
      { count: 8, windowMinutes: 60 },
      {
        id: 'v1',
        at: NOW,
        by: 'a.admin@contoso.com',
      },
    )
    expect(after).toEqual({
      id: 'v1',
      previousId: 'v0',
      createdAt: NOW,
      createdBy: 'a.admin@contoso.com',
      thresholds: {
        repeated_failures: { count: 8, windowMinutes: 60, inEffectSince: NOW },
        password_spray: { count: 10, windowMinutes: 60, inEffectSince: SEEDED },
      },
      sensitiveApps: [],
    })
    expect(before.thresholds.repeated_failures.count).toBe(10)
  })
})

describe('withSensitiveApp (AC-4)', () => {
  const workday = { appId: '6c1f6a2e-3b7d-4f1e-9a35-0d7f4b2c9e11', appName: 'Workday', addedBy: 'Ana Admin' }

  it('appends the app with who added it and when, keeping the thresholds and their dates', () => {
    const before = initialVersion('v0', SEEDED)
    const after = withSensitiveApp(before, workday, { id: 'v1', at: NOW, by: 'a.admin@contoso.com' })
    expect(after.previousId).toBe('v0')
    expect(after.thresholds).toEqual(before.thresholds)
    expect(after.sensitiveApps).toEqual([{ ...workday, addedAt: NOW }])
    expect(before.sensitiveApps).toEqual([])
    expect(isSensitive(after, workday.appId)).toBe(true)
    expect(isSensitive(before, workday.appId)).toBe(false)
  })
})

describe('reportDateFor (AC-3)', () => {
  it('a change saved on 12 October applies from the 12 October report', () => {
    expect(reportDateFor(NOW)).toBe('2026-10-12')
  })

  it('the last instant of a UTC day still belongs to that day’s report', () => {
    expect(reportDateFor(new Date('2026-10-12T23:59:59.999Z'))).toBe('2026-10-12')
  })

  it('midnight UTC belongs to the next day’s report', () => {
    expect(reportDateFor(new Date('2026-10-13T00:00:00.000Z'))).toBe('2026-10-13')
  })
})
