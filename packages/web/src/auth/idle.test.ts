import { describe, expect, it } from 'vitest'
import { sessionTimers, WARNING_LEAD_MS } from './idle'
import { readerMe, SIGNED_IN_AT } from '../test-support/fixtures'

const minute = 60_000

describe('sessionTimers schedules from the limits the server sent', () => {
  it('warns 2 minutes before the idle limit, i.e. after 13 idle minutes, and ends at 15', () => {
    expect(WARNING_LEAD_MS).toBe(2 * minute)
    expect(sessionTimers(readerMe, SIGNED_IN_AT)).toEqual({ warnInMs: 13 * minute, endInMs: 15 * minute })
  })

  it('warns at once when already inside the warning window', () => {
    expect(sessionTimers(readerMe, SIGNED_IN_AT + 14 * minute)).toEqual({ warnInMs: 0, endInMs: minute })
  })

  it('ends at the 8-hour absolute limit when it comes first, without an idle warning', () => {
    const me = {
      ...readerMe,
      idleExpiresAt: new Date(SIGNED_IN_AT + 8 * 60 * minute + 10 * minute).toISOString(),
    }
    expect(sessionTimers(me, SIGNED_IN_AT + 8 * 60 * minute - minute)).toEqual({ warnInMs: null, endInMs: minute })
  })

  it('never schedules in the past', () => {
    expect(sessionTimers(readerMe, SIGNED_IN_AT + 16 * minute)).toEqual({ warnInMs: 0, endInMs: 0 })
  })
})
