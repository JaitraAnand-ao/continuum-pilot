import { describe, expect, it } from 'vitest'
import { CollectionFailedError, collectAll, windowFor } from '../src/index.js'
import { FakeClock, FakeSignInSource, manySignIns } from './fakes.js'

const window = windowFor('2026-10-11')

describe('collectAll (AC-3, AC-5)', () => {
  it('follows every page until there is no next link', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const source = new FakeSignInSource(manySignIns(2500, '2026-10-11'), { pageSize: 1000 })
    const items = await collectAll((cursor) => source.fetchSignInsPage(window, cursor), {
      clock,
      sleeper: clock,
      deadline: new Date('2026-10-12T07:00:00Z'),
    })
    expect(items).toHaveLength(2500)
    expect(source.calls.map((call) => call.cursor)).toEqual([null, '1000', '2000'])
  })

  it('retries a throttled page with the same cursor after at least Retry-After seconds', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const source = new FakeSignInSource(manySignIns(3000, '2026-10-11'), {
      pageSize: 1000,
      throttle: { atCursor: '1000', retryAfterSeconds: 5 },
      clock,
    })
    const items = await collectAll((cursor) => source.fetchSignInsPage(window, cursor), {
      clock,
      sleeper: clock,
      deadline: new Date('2026-10-12T07:00:00Z'),
    })
    expect(items).toHaveLength(3000)
    const [throttled, retried] = source.calls.filter((call) => call.cursor === '1000')
    expect(retried!.at - throttled!.at).toBeGreaterThanOrEqual(5000)
  })

  it('backs off and retries a failing call, then gives up at the deadline', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const source = new FakeSignInSource([], { failAlways: true, clock })
    await expect(
      collectAll((cursor) => source.fetchSignInsPage(window, cursor), {
        clock,
        sleeper: clock,
        deadline: new Date('2026-10-12T07:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(CollectionFailedError)
    expect(source.calls.length).toBeGreaterThan(5)
    const last = source.calls.at(-1)!
    expect(last.at).toBeLessThan(Date.parse('2026-10-12T07:00:00Z'))
    expect(clock.now().toISOString()).toBe('2026-10-12T07:00:00.000Z')
  })

  it('recovers when a failing call succeeds before the deadline', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    let failures = 2
    const items = await collectAll(
      async () => {
        if (failures > 0) {
          failures -= 1
          throw new Error('graph 502')
        }
        return { kind: 'page' as const, items: [1, 2], next: null }
      },
      { clock, sleeper: clock, deadline: new Date('2026-10-12T07:00:00Z') },
    )
    expect(items).toEqual([1, 2])
  })

  it('does not start when the deadline has already passed', async () => {
    const clock = new FakeClock('2026-10-12T07:00:00Z')
    let called = 0
    await expect(
      collectAll(
        async () => {
          called += 1
          return { kind: 'page' as const, items: [], next: null }
        },
        { clock, sleeper: clock, deadline: new Date('2026-10-12T07:00:00Z') },
      ),
    ).rejects.toBeInstanceOf(CollectionFailedError)
    expect(called).toBe(0)
  })

  it('fails rather than sleep past the deadline when Retry-After would cross it', async () => {
    const clock = new FakeClock('2026-10-12T06:59:58Z')
    await expect(
      collectAll(async () => ({ kind: 'throttled' as const, retryAfterSeconds: 5 }), {
        clock,
        sleeper: clock,
        deadline: new Date('2026-10-12T07:00:00Z'),
      }),
    ).rejects.toThrow(/deadline/)
  })
})
