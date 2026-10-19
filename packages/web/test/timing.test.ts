import { describe, expect, it } from 'vitest'
import { msUntilPhaseChange, sessionPhase, utcClock } from '../src/session/timing'
import { meFor, SIGNED_IN_AT } from './fixtures'

const minutes = (n: number) => n * 60 * 1000
const me = meFor(['reader'])

describe('AC-9 session phases from the server limits', () => {
  it('is active until 2 minutes before the idle limit', () => {
    expect(sessionPhase(me, SIGNED_IN_AT)).toBe('active')
    expect(sessionPhase(me, SIGNED_IN_AT + minutes(13) - 1)).toBe('active')
    expect(msUntilPhaseChange(me, SIGNED_IN_AT)).toBe(minutes(13))
  })

  it('warns from 13 minutes idle', () => {
    expect(sessionPhase(me, SIGNED_IN_AT + minutes(13))).toBe('warning')
    expect(msUntilPhaseChange(me, SIGNED_IN_AT + minutes(13))).toBe(minutes(2))
  })

  it('ends at 15 minutes idle', () => {
    expect(sessionPhase(me, SIGNED_IN_AT + minutes(15))).toBe('expired')
    expect(msUntilPhaseChange(me, SIGNED_IN_AT + minutes(15))).toBeNull()
  })

  it('ends at the 8-hour limit even when the idle limit is later', () => {
    const active = meFor(['reader'], { idleExpiresAt: '2026-10-19T16:10:00Z' })
    expect(sessionPhase(active, Date.parse('2026-10-19T15:59:00Z'))).toBe('active')
    expect(msUntilPhaseChange(active, Date.parse('2026-10-19T15:59:00Z'))).toBe(minutes(1))
    expect(sessionPhase(active, Date.parse('2026-10-19T16:01:00Z'))).toBe('expired')
  })

  it('formats the idle limit as a UTC clock', () => {
    expect(utcClock(me.idleExpiresAt)).toBe('08:15')
  })
})
