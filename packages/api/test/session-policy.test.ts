import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_LIMIT_MS,
  IDLE_LIMIT_MS,
  absoluteExpiresAt,
  idleExpiresAt,
  isSessionExpired,
} from '../src/session-policy.js'

const createdAt = new Date('2026-10-19T08:00:00.000Z')

describe('AC-9 session limits', () => {
  it('are 15 minutes idle and 8 hours absolute', () => {
    expect(IDLE_LIMIT_MS).toBe(900_000)
    expect(ABSOLUTE_LIMIT_MS).toBe(28_800_000)
  })

  it('ends a session at the idle limit, not one millisecond before it', () => {
    const lastSeenAt = new Date('2026-10-19T09:00:00.000Z')
    const times = { createdAt, lastSeenAt }
    expect(idleExpiresAt(times).toISOString()).toBe('2026-10-19T09:15:00.000Z')
    expect(isSessionExpired(times, new Date('2026-10-19T09:14:59.999Z'))).toBe(false)
    expect(isSessionExpired(times, new Date('2026-10-19T09:15:00.000Z'))).toBe(true)
  })

  it('ends a session at 8 hours even while it stays active', () => {
    const times = { createdAt, lastSeenAt: new Date('2026-10-19T15:59:00.000Z') }
    expect(absoluteExpiresAt(times).toISOString()).toBe('2026-10-19T16:00:00.000Z')
    expect(isSessionExpired(times, new Date('2026-10-19T15:59:59.999Z'))).toBe(false)
    expect(isSessionExpired(times, new Date('2026-10-19T16:00:00.000Z'))).toBe(true)
  })
})
