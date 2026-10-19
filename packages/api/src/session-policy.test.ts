import { describe, expect, it } from 'vitest'
import { ABSOLUTE_LIMIT_MS, IDLE_LIMIT_MS, IDLE_WARNING_LEAD_MS, expiryReason, sessionLimits } from './session-policy'

const createdAt = new Date('2026-10-19T08:00:00.000Z')
const at = (ms: number) => new Date(createdAt.getTime() + ms)

describe('session policy (AD-5, ST-1 AC-9)', () => {
  it('fixes the idle limit at 15 minutes, the absolute limit at 8 hours and the warning 2 minutes ahead', () => {
    expect(IDLE_LIMIT_MS).toBe(15 * 60 * 1000)
    expect(ABSOLUTE_LIMIT_MS).toBe(8 * 60 * 60 * 1000)
    expect(IDLE_WARNING_LEAD_MS).toBeGreaterThanOrEqual(2 * 60 * 1000)
  })

  it('derives the limits from the creation and last-activity instants', () => {
    const lastSeenAt = at(60 * 60 * 1000)
    expect(sessionLimits({ createdAt, lastSeenAt })).toEqual({
      idleExpiresAt: new Date('2026-10-19T09:15:00.000Z'),
      idleWarningAt: new Date('2026-10-19T09:13:00.000Z'),
      absoluteExpiresAt: new Date('2026-10-19T16:00:00.000Z'),
    })
  })

  it('keeps a session one millisecond below the idle limit and ends it at the limit', () => {
    const times = { createdAt, lastSeenAt: createdAt }
    expect(expiryReason(times, at(IDLE_LIMIT_MS - 1))).toBeNull()
    expect(expiryReason(times, at(IDLE_LIMIT_MS))).toBe('idle')
  })

  it('keeps an active session one millisecond below 8 hours and ends it at 8 hours', () => {
    const lastSeenAt = at(ABSOLUTE_LIMIT_MS - 60 * 1000)
    expect(expiryReason({ createdAt, lastSeenAt }, at(ABSOLUTE_LIMIT_MS - 1))).toBeNull()
    expect(expiryReason({ createdAt, lastSeenAt }, at(ABSOLUTE_LIMIT_MS))).toBe('absolute')
  })

  it('reports the absolute limit when both have passed', () => {
    expect(expiryReason({ createdAt, lastSeenAt: createdAt }, at(ABSOLUTE_LIMIT_MS + 1))).toBe('absolute')
  })
})
