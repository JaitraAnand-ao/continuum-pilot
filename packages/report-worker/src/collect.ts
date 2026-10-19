import type { Clock, Page, Sleeper } from './ports.js'

export class CollectionFailedError extends Error {
  constructor(readonly cause: unknown) {
    super('Graph collection did not finish before the retry deadline')
    this.name = 'CollectionFailedError'
  }
}

export interface CollectOptions {
  readonly clock: Clock
  readonly sleeper: Sleeper
  readonly deadline: Date
  readonly initialBackoffMs?: number
  readonly maxBackoffMs?: number
}

/**
 * Follows every page. A 429 is retried with the same cursor after Retry-After; any other
 * failure is retried with capped exponential backoff. Nothing is retried at or past the deadline.
 */
export async function collectAll<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
  options: CollectOptions,
): Promise<T[]> {
  const { clock, sleeper, deadline } = options
  const maxBackoff = options.maxBackoffMs ?? 15 * 60_000
  let backoff = options.initialBackoffMs ?? 30_000
  let lastProblem: unknown = new Error('deadline already passed')
  const items: T[] = []
  let cursor: string | null = null

  const waitOrGiveUp = async (ms: number): Promise<void> => {
    const remaining = deadline.getTime() - clock.now().getTime()
    if (ms >= remaining) {
      await sleeper.sleep(Math.max(remaining, 0))
      throw new CollectionFailedError(lastProblem)
    }
    await sleeper.sleep(ms)
  }

  for (;;) {
    if (clock.now().getTime() >= deadline.getTime()) throw new CollectionFailedError(lastProblem)
    let page: Page<T>
    try {
      page = await fetchPage(cursor)
    } catch (problem) {
      lastProblem = problem
      await waitOrGiveUp(backoff)
      backoff = Math.min(backoff * 2, maxBackoff)
      continue
    }
    if (page.kind === 'throttled') {
      lastProblem = new Error(`throttled, Retry-After ${page.retryAfterSeconds}s`)
      await waitOrGiveUp(Math.max(page.retryAfterSeconds, 1) * 1000)
      continue
    }
    for (const item of page.items) items.push(item)
    if (page.next === null) return items
    cursor = page.next
  }
}
