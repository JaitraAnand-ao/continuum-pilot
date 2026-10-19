import { describe, expect, it } from 'vitest'
import { collectAllPages, GraphThrottledError, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS, type Page } from '../src/index.js'
import { FakeClock, FakeSleeper } from './support/fakes.js'

function pagedSource(pages: number[][], failures: Record<number, Error[]> = {}) {
  const requested: (string | undefined)[] = []
  return {
    requested,
    fetch: async (cursor?: string): Promise<Page<number>> => {
      requested.push(cursor)
      const index = cursor === undefined ? 0 : Number(cursor)
      const failure = failures[index]?.shift()
      if (failure) throw failure
      return { items: pages[index] ?? [], ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}) }
    },
  }
}

describe('collecting every page (AC-3)', () => {
  it('follows the cursor to the last page', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const source = pagedSource([[1, 2], [3, 4], [5]])
    const result = await collectAllPages(
      source.fetch,
      new Date('2026-10-12T07:00:00.000Z'),
      clock,
      new FakeSleeper(clock),
    )
    expect(result).toEqual({ ok: true, items: [1, 2, 3, 4, 5] })
    expect(source.requested).toEqual([undefined, '1', '2'])
  })

  it('asks for a throttled page again from the same cursor after Retry-After', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const sleeper = new FakeSleeper(clock)
    const source = pagedSource([[1], [2], [3]], { 1: [new GraphThrottledError(5)] })
    const result = await collectAllPages(source.fetch, new Date('2026-10-12T07:00:00.000Z'), clock, sleeper)
    expect(result).toEqual({ ok: true, items: [1, 2, 3] })
    expect(source.requested).toEqual([undefined, '1', '1', '2'])
    expect(sleeper.sleeps).toEqual([5000])
  })

  it('backs off exponentially on other failures, capped, and resets after a good page', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const sleeper = new FakeSleeper(clock)
    const failures = Array.from({ length: 6 }, () => new Error('503'))
    const source = pagedSource([[1], [2]], { 0: failures, 1: [new Error('503')] })
    const result = await collectAllPages(source.fetch, new Date('2026-10-12T07:00:00.000Z'), clock, sleeper)
    expect(result).toEqual({ ok: true, items: [1, 2] })
    expect(sleeper.sleeps).toEqual([
      INITIAL_BACKOFF_MS,
      INITIAL_BACKOFF_MS * 2,
      INITIAL_BACKOFF_MS * 4,
      INITIAL_BACKOFF_MS * 8,
      INITIAL_BACKOFF_MS * 16,
      MAX_BACKOFF_MS,
      INITIAL_BACKOFF_MS,
    ])
  })
})

describe('the retry deadline (AC-5)', () => {
  const deadline = new Date('2026-10-12T07:00:00.000Z')

  it('still waits when the retry lands exactly on the deadline', async () => {
    const clock = new FakeClock('2026-10-12T06:59:55.000Z')
    const source = pagedSource([[1]], { 0: [new GraphThrottledError(5)] })
    const result = await collectAllPages(source.fetch, deadline, clock, new FakeSleeper(clock))
    expect(result).toEqual({ ok: true, items: [1] })
  })

  it('gives the source up when the retry would land one millisecond after the deadline', async () => {
    const clock = new FakeClock('2026-10-12T06:59:55.001Z')
    const sleeper = new FakeSleeper(clock)
    const source = pagedSource([[1]], { 0: [new GraphThrottledError(5)] })
    const result = await collectAllPages(source.fetch, deadline, clock, sleeper)
    expect(result).toEqual({ ok: false })
    expect(sleeper.sleeps).toEqual([])
  })

  it('gives up a source that keeps failing, without retrying past 07:00 UTC', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const always = { [Symbol.iterator]: undefined, shift: () => new Error('500') } as unknown as Error[]
    const source = pagedSource([[1]], { 0: always })
    const result = await collectAllPages(source.fetch, deadline, clock, new FakeSleeper(clock))
    expect(result).toEqual({ ok: false })
    expect(clock.now().getTime()).toBeLessThanOrEqual(deadline.getTime())
    expect(source.requested.length).toBeGreaterThan(5)
  })
})
