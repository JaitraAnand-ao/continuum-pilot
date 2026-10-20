import { describe, expect, it } from 'vitest'
import { collectPages, GraphThrottledError, type Page } from '../src/index.js'
import { FakeClock } from './support.js'

const deadline = new Date('2026-10-12T07:00:00.000Z')

function pages(count: number): (cursor: string | undefined) => Promise<Page<number>> {
  return async (cursor) => {
    const index = cursor === undefined ? 0 : Number(cursor)
    return index + 1 < count ? { items: [index], next: String(index + 1) } : { items: [index] }
  }
}

describe('collectPages (AC-3)', () => {
  it('follows next links until the last page', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const result = await collectPages(pages(5), { clock, deadline })
    expect(result).toEqual({ ok: true, items: [0, 1, 2, 3, 4] })
  })

  it('waits Retry-After on 429 and resumes from the throttled page', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const seen: (string | undefined)[] = []
    let throttled = false
    const result = await collectPages<number>(
      async (cursor) => {
        seen.push(cursor)
        if (cursor === '2' && !throttled) {
          throttled = true
          throw new GraphThrottledError(5)
        }
        return pages(4)(cursor)
      },
      { clock, deadline },
    )
    expect(result).toEqual({ ok: true, items: [0, 1, 2, 3] })
    expect(clock.sleeps).toEqual([5000])
    expect(seen).toEqual([undefined, '1', '2', '2', '3'])
  })

  it('backs off exponentially on errors, capped at five minutes', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    let failures = 12
    const result = await collectPages<number>(
      async (cursor) => {
        if (failures-- > 0) throw new Error('503')
        return pages(1)(cursor)
      },
      { clock, deadline },
    )
    expect(result.ok).toBe(true)
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000])
  })

  it('gives up with what it has when the next attempt would fall at or after 07:00 UTC', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const result = await collectPages<number>(
      async (cursor) => {
        if (cursor === '1') throw new Error('503')
        return pages(3)(cursor)
      },
      { clock, deadline },
    )
    expect(result).toMatchObject({ ok: false, items: [0] })
    expect(clock.now().getTime()).toBeLessThan(deadline.getTime())
    expect(clock.now().getTime() + 300000).toBeGreaterThanOrEqual(deadline.getTime())
  })

  it('still makes one attempt when started after the deadline, and retries a wait ending one ms before it', async () => {
    const late = new FakeClock('2026-10-12T07:10:00.000Z')
    expect(await collectPages(pages(1), { clock: late, deadline })).toEqual({ ok: true, items: [0] })

    const edge = new FakeClock('2026-10-12T06:59:54.999Z')
    let first = true
    const result = await collectPages<number>(
      async (cursor) => {
        if (first) {
          first = false
          throw new GraphThrottledError(5)
        }
        return pages(1)(cursor)
      },
      { clock: edge, deadline },
    )
    expect(result.ok).toBe(true)

    const atEdge = new FakeClock('2026-10-12T06:59:55.000Z')
    const failed = await collectPages<number>(
      async () => {
        throw new GraphThrottledError(5)
      },
      { clock: atEdge, deadline },
    )
    expect(failed.ok).toBe(false)
    expect(atEdge.sleeps).toEqual([])
  })
})
