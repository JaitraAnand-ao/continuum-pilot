/* ST-1 AC-9: the 15-minute idle and 8-hour absolute limits, each proven at the limit and one millisecond below. */
import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_LIMIT_MS,
  IDLE_LIMIT_MS,
  IDLE_WARNING_LEAD_MS,
  absoluteExpiresAt,
  idleExpiresAt,
  idleWarningAt,
  sessionState,
} from '../src/session/policy.js'

const createdAt = new Date('2026-10-19T08:00:00.000Z')
const at = (iso: string) => new Date(iso)

describe('session limits (AD-5)', () => {
  it('fixes the limits at 15 minutes idle, 8 hours absolute and a 2-minute warning lead', () => {
    expect(IDLE_LIMIT_MS).toBe(900_000)
    expect(ABSOLUTE_LIMIT_MS).toBe(28_800_000)
    expect(IDLE_WARNING_LEAD_MS).toBe(120_000)
  })

  it('is still active one millisecond before 15 minutes idle', () => {
    expect(sessionState({ createdAt, lastSeenAt: createdAt }, at('2026-10-19T08:14:59.999Z'))).toBe('active')
  })

  it('ends at exactly 15 minutes idle', () => {
    expect(sessionState({ createdAt, lastSeenAt: createdAt }, at('2026-10-19T08:15:00.000Z'))).toBe('idle-expired')
  })

  it('measures idle from the last activity, not from sign-in', () => {
    const lastSeenAt = at('2026-10-19T10:00:00.000Z')
    expect(sessionState({ createdAt, lastSeenAt }, at('2026-10-19T10:14:59.999Z'))).toBe('active')
    expect(sessionState({ createdAt, lastSeenAt }, at('2026-10-19T10:15:00.000Z'))).toBe('idle-expired')
  })

  it('is still active one millisecond before 8 hours even when used a minute ago', () => {
    const lastSeenAt = at('2026-10-19T15:59:00.000Z')
    expect(sessionState({ createdAt, lastSeenAt }, at('2026-10-19T15:59:59.999Z'))).toBe('active')
  })

  it('ends at exactly 8 hours even when used a minute ago', () => {
    const lastSeenAt = at('2026-10-19T15:59:00.000Z')
    expect(sessionState({ createdAt, lastSeenAt }, at('2026-10-19T16:00:00.000Z'))).toBe('absolute-expired')
    expect(sessionState({ createdAt, lastSeenAt }, at('2026-10-19T16:01:00.000Z'))).toBe('absolute-expired')
  })

  it('reports the idle and absolute expiry instants', () => {
    const lastSeenAt = at('2026-10-19T09:00:00.000Z')
    expect(idleExpiresAt({ createdAt, lastSeenAt }).toISOString()).toBe('2026-10-19T09:15:00.000Z')
    expect(absoluteExpiresAt({ createdAt, lastSeenAt }).toISOString()).toBe('2026-10-19T16:00:00.000Z')
  })

  it('never reports an idle expiry later than the absolute one', () => {
    const lastSeenAt = at('2026-10-19T15:50:00.000Z')
    expect(idleExpiresAt({ createdAt, lastSeenAt }).toISOString()).toBe('2026-10-19T16:00:00.000Z')
  })

  it('warns 2 minutes before the idle limit, at 13 minutes idle', () => {
    expect(idleWarningAt({ createdAt, lastSeenAt: createdAt }).toISOString()).toBe('2026-10-19T08:13:00.000Z')
  })
})
