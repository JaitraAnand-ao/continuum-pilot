/* AD-5 session limits (ST-1 AC-9) and the login-transaction lifetime, at each boundary and one below it. */
import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  IDLE_WARNING_LEAD_MS,
  LOGIN_TRANSACTION_TTL_MS,
  loginTransactionExpired,
  sessionExpiry,
  sessionStatus,
} from '../src/session/policy.js'

const createdAt = new Date('2026-10-19T08:00:00.000Z')
const at = (ms: number) => new Date(createdAt.getTime() + ms)

describe('session limits', () => {
  it('are 15 minutes idle, 8 hours absolute and a warning at least 2 minutes before idle expiry', () => {
    expect(IDLE_TIMEOUT_MS).toBe(15 * 60_000)
    expect(ABSOLUTE_TIMEOUT_MS).toBe(8 * 3_600_000)
    expect(IDLE_WARNING_LEAD_MS).toBeGreaterThanOrEqual(2 * 60_000)
    expect(IDLE_WARNING_LEAD_MS).toBeLessThan(IDLE_TIMEOUT_MS)
  })

  it('puts idle expiry 15 minutes after the last activity and absolute expiry 8 hours after sign-in', () => {
    const lastSeenAt = at(60 * 60_000)
    expect(sessionExpiry({ createdAt, lastSeenAt })).toEqual({
      idleExpiresAt: new Date('2026-10-19T09:15:00.000Z'),
      absoluteExpiresAt: new Date('2026-10-19T16:00:00.000Z'),
    })
  })

  it('caps idle expiry at the absolute limit', () => {
    const lastSeenAt = at(ABSOLUTE_TIMEOUT_MS - 60_000)
    expect(sessionExpiry({ createdAt, lastSeenAt }).idleExpiresAt).toEqual(new Date('2026-10-19T16:00:00.000Z'))
  })

  it('is active one millisecond before 15 minutes idle and idle-expired at 15 minutes', () => {
    const times = { createdAt, lastSeenAt: createdAt }
    expect(sessionStatus(times, at(IDLE_TIMEOUT_MS - 1))).toBe('active')
    expect(sessionStatus(times, at(IDLE_TIMEOUT_MS))).toBe('idle-expired')
  })

  it('is active one millisecond before 8 hours and absolute-expired at 8 hours, however recent the activity', () => {
    const lastSeenAt = at(ABSOLUTE_TIMEOUT_MS - 60_000)
    expect(sessionStatus({ createdAt, lastSeenAt }, at(ABSOLUTE_TIMEOUT_MS - 1))).toBe('active')
    expect(sessionStatus({ createdAt, lastSeenAt }, at(ABSOLUTE_TIMEOUT_MS))).toBe('absolute-expired')
  })
})

describe('login transaction', () => {
  it('lives 5 minutes: valid one millisecond before, expired at the limit', () => {
    expect(LOGIN_TRANSACTION_TTL_MS).toBe(300_000)
    expect(loginTransactionExpired(createdAt, at(LOGIN_TRANSACTION_TTL_MS - 1))).toBe(false)
    expect(loginTransactionExpired(createdAt, at(LOGIN_TRANSACTION_TTL_MS))).toBe(true)
  })

  it('is expired when it claims to start in the future', () => {
    expect(loginTransactionExpired(at(1), createdAt)).toBe(true)
  })
})
