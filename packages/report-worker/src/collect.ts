import { GraphThrottledError, type Clock, type Page } from './ports.js'

const FIRST_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 300_000

export type CollectResult<T> = { ok: true; items: T[] } | { ok: false; items: T[]; error: unknown }

/* Follows next links to the last page. A 429 waits its Retry-After and a failure backs off exponentially,
 * both resuming from the page that failed, until the next attempt would fall at or after the deadline. */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  options: { clock: Clock; deadline: Date },
): Promise<CollectResult<T>> {
  const items: T[] = []
  let cursor: string | undefined
  let failures = 0
  for (;;) {
    try {
      const page = await fetchPage(cursor)
      for (const item of page.items) items.push(item)
      failures = 0
      if (page.next === undefined) return { ok: true, items }
      cursor = page.next
    } catch (error) {
      failures++
      const waitMs =
        error instanceof GraphThrottledError
          ? error.retryAfterSeconds * 1000
          : Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
      if (options.clock.now().getTime() + waitMs >= options.deadline.getTime()) return { ok: false, items, error }
      await options.clock.sleep(waitMs)
    }
  }
}
