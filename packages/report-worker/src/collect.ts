import type { Clock, Sleeper } from './clock.js'
import { GraphThrottledError, type Page } from './ports.js'

export const INITIAL_BACKOFF_MS = 30_000
export const MAX_BACKOFF_MS = 600_000

export type Collected<T> = { ok: true; items: T[] } | { ok: false }

/* Walks every page of one source. A failed page is asked for again from the same cursor —
 * after Retry-After when Graph throttles, with capped exponential backoff otherwise — until the
 * next attempt would fall after the deadline; then the source is reported as not collected. */
export async function collectAllPages<T>(
  fetchPage: (cursor?: string) => Promise<Page<T>>,
  deadline: Date,
  clock: Clock,
  sleeper: Sleeper,
): Promise<Collected<T>> {
  const items: T[] = []
  let cursor: string | undefined
  let backoff = INITIAL_BACKOFF_MS
  for (;;) {
    try {
      const page = await fetchPage(cursor)
      items.push(...page.items)
      if (page.nextCursor === undefined) return { ok: true, items }
      cursor = page.nextCursor
      backoff = INITIAL_BACKOFF_MS
    } catch (problem) {
      const wait = problem instanceof GraphThrottledError ? problem.retryAfterSeconds * 1000 : backoff
      if (!(problem instanceof GraphThrottledError)) backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      if (clock.now().getTime() + wait > deadline.getTime()) return { ok: false }
      await sleeper.sleep(wait)
    }
  }
}
