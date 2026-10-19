import { describe, expect, it } from 'vitest'
import { collectPages, type GraphPage } from '../src/index.js'
import { FakeClock } from './support/fakes.js'

const deadline = new Date('2026-10-12T07:00:00Z')
const retry = { initialDelaySeconds: 30, maxDelaySeconds: 900 }

function pages(...answers: GraphPage<number>[]) {
  const cursors: (string | null)[] = []
  const read = async (cursor: string | null) => {
    cursors.push(cursor)
    const answer = answers.shift()
    if (answer === undefined) throw new Error('read past the scripted answers')
    return answer
  }
  return { read, cursors }
}

describe('collectPages (AC-3)', () => {
  it('follows every next cursor until Graph says there is no more', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const graph = pages(
      { kind: 'page', items: [1, 2], nextCursor: 'p2' },
      { kind: 'page', items: [3], nextCursor: 'p3' },
      { kind: 'page', items: [], nextCursor: null },
    )
    const result = await collectPages(graph.read, { clock, sleeper: clock, deadline, retry })
    expect(result).toEqual({ ok: true, items: [1, 2, 3] })
    expect(graph.cursors).toEqual([null, 'p2', 'p3'])
    expect(clock.sleeps).toEqual([])
  })

  it('waits at least Retry-After on 429 and then asks for the same page again', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const graph = pages(
      { kind: 'page', items: [1], nextCursor: 'p2' },
      { kind: 'throttled', retryAfterSeconds: 5 },
      { kind: 'page', items: [2], nextCursor: null },
    )
    const result = await collectPages(graph.read, { clock, sleeper: clock, deadline, retry })
    expect(result).toEqual({ ok: true, items: [1, 2] })
    expect(graph.cursors).toEqual([null, 'p2', 'p2'])
    expect(clock.sleeps).toEqual([5000])
  })

  it('waits one second when Retry-After is missing or zero', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const graph = pages({ kind: 'throttled', retryAfterSeconds: 0 }, { kind: 'page', items: [], nextCursor: null })
    await collectPages(graph.read, { clock, sleeper: clock, deadline, retry })
    expect(clock.sleeps).toEqual([1000])
  })

  it('retries a failed page with growing, capped back-off, keeping pages already read', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const failed = { kind: 'failed', reason: 'HTTP 503' } as const
    const graph = pages({ kind: 'page', items: [1], nextCursor: 'p2' }, ...Array.from({ length: 7 }, () => failed), {
      kind: 'page',
      items: [2],
      nextCursor: null,
    })
    const result = await collectPages(graph.read, { clock, sleeper: clock, deadline, retry })
    expect(result).toEqual({ ok: true, items: [1, 2] })
    expect(clock.sleeps).toEqual([30, 60, 120, 240, 480, 900, 900].map((s) => s * 1000))
    expect(graph.cursors.slice(1).every((c) => c === 'p2')).toBe(true)
  })

  it('treats a thrown read as a failed attempt', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    let calls = 0
    const read = async (): Promise<GraphPage<number>> => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return { kind: 'page', items: [9], nextCursor: null }
    }
    expect(await collectPages(read, { clock, sleeper: clock, deadline, retry })).toEqual({ ok: true, items: [9] })
  })

  it('gives up at the retry deadline and never sleeps past it', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00Z')
    const read = async (): Promise<GraphPage<number>> => ({ kind: 'failed', reason: 'HTTP 503' })
    const result = await collectPages(read, { clock, sleeper: clock, deadline, retry })
    expect(result).toEqual({ ok: false, reason: 'retry deadline reached' })
    expect(clock.now().getTime()).toBe(deadline.getTime())
  })

  it('gives up when a Retry-After would end after the deadline', async () => {
    const clock = new FakeClock('2026-10-12T06:59:58Z')
    const read = async (): Promise<GraphPage<number>> => ({ kind: 'throttled', retryAfterSeconds: 5 })
    const result = await collectPages(read, { clock, sleeper: clock, deadline, retry })
    expect(result).toEqual({ ok: false, reason: 'retry deadline reached' })
    expect(clock.sleeps).toEqual([])
  })

  it('does not call Graph at all once the deadline has passed', async () => {
    const clock = new FakeClock('2026-10-12T07:00:00Z')
    const graph = pages()
    expect(await collectPages(graph.read, { clock, sleeper: clock, deadline, retry })).toEqual({
      ok: false,
      reason: 'retry deadline reached',
    })
    expect(graph.cursors).toEqual([])
  })
})
