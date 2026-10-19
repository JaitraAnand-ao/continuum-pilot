import { describe, expect, it } from 'vitest'
import { ABSOLUTE_LIMIT_MS, IDLE_LIMIT_MS, sessionExpiries, sessionState } from './policy.js'

const createdAt = new Date('2026-10-19T08:00:00.000Z')
const at = (ms: number): Date => new Date(createdAt.getTime() + ms)

describe('AC-9 session limits (AD-5)', () => {
  it('fixes the idle limit at 15 minutes and the absolute limit at 8 hours', () => {
    expect(IDLE_LIMIT_MS).toBe(15 * 60 * 1000)
    expect(ABSOLUTE_LIMIT_MS).toBe(8 * 60 * 60 * 1000)
  })

  it('is active one millisecond before 15 minutes idle and idle-expired at 15 minutes', () => {
    const times = { createdAt, lastSeenAt: createdAt }
    expect(sessionState(times, at(IDLE_LIMIT_MS - 1))).toBe('active')
    expect(sessionState(times, at(IDLE_LIMIT_MS))).toBe('idle-expired')
  })

  it('measures idle from the last activity, not from sign-in', () => {
    const times = { createdAt, lastSeenAt: at(10 * 60 * 1000) }
    expect(sessionState(times, at(24 * 60 * 1000))).toBe('active')
    expect(sessionState(times, at(25 * 60 * 1000))).toBe('idle-expired')
  })

  it('is active one millisecond before 8 hours and absolute-expired at 8 hours even when just used', () => {
    expect(sessionState({ createdAt, lastSeenAt: at(ABSOLUTE_LIMIT_MS - 60_000) }, at(ABSOLUTE_LIMIT_MS - 1))).toBe(
      'active',
    )
    expect(sessionState({ createdAt, lastSeenAt: at(ABSOLUTE_LIMIT_MS - 1) }, at(ABSOLUTE_LIMIT_MS))).toBe(
      'absolute-expired',
    )
  })

  it('ends a session used every few minutes since 08:00 when it is opened at 16:01', () => {
    const lastSeenAt = new Date('2026-10-19T15:58:00.000Z')
    expect(sessionState({ createdAt, lastSeenAt }, new Date('2026-10-19T16:01:00.000Z'))).toBe('absolute-expired')
  })

  it('reports the idle and absolute expiry instants, never letting idle outlive absolute', () => {
    expect(sessionExpiries({ createdAt, lastSeenAt: at(60_000) })).toEqual({
      idleExpiresAt: at(60_000 + IDLE_LIMIT_MS),
      absoluteExpiresAt: at(ABSOLUTE_LIMIT_MS),
    })
    expect(sessionExpiries({ createdAt, lastSeenAt: at(ABSOLUTE_LIMIT_MS - 60_000) })).toEqual({
      idleExpiresAt: at(ABSOLUTE_LIMIT_MS),
      absoluteExpiresAt: at(ABSOLUTE_LIMIT_MS),
    })
  })
})
