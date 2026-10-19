/* Reads every page of one Graph collection, honouring Retry-After on 429 and retrying
 * failures with capped exponential back-off until the retry deadline (AC-3, AC-5). */
import type { Clock, Sleeper } from './clock.js'
import type { GraphPage } from './signins.js'

export interface RetryPolicy {
  initialDelaySeconds: number
  maxDelaySeconds: number
}

export const DEFAULT_RETRY: RetryPolicy = { initialDelaySeconds: 30, maxDelaySeconds: 900 }

export type Collected<T> = { ok: true; items: T } | { ok: false; reason: string }

export interface CollectOptions {
  clock: Clock
  sleeper: Sleeper
  deadline: Date
  retry: RetryPolicy
}

const DEADLINE_REACHED = { ok: false, reason: 'retry deadline reached' } as const

export async function collectPages<T>(
  readPage: (cursor: string | null) => Promise<GraphPage<T>>,
  { clock, sleeper, deadline, retry }: CollectOptions,
): Promise<Collected<T[]>> {
  const items: T[] = []
  let cursor: string | null = null
  let failures = 0
  for (;;) {
    if (clock.now().getTime() >= deadline.getTime()) return DEADLINE_REACHED
    let page: GraphPage<T>
    try {
      page = await readPage(cursor)
    } catch {
      page = { kind: 'failed', reason: 'read threw' }
    }
    if (page.kind === 'page') {
      /* A loop, not push(...items): a spread of a large page overflows the call stack. */
      for (const item of page.items) items.push(item)
      failures = 0
      if (page.nextCursor === null) return { ok: true, items }
      cursor = page.nextCursor
      continue
    }
    const left = deadline.getTime() - clock.now().getTime()
    if (page.kind === 'throttled') {
      /* Retry-After is a floor: waiting less loses the page, so a wait that would end past
       * the deadline is a failure of this collection, not a shorter wait. */
      const wait = Math.max(page.retryAfterSeconds, 1) * 1000
      if (wait > left) return DEADLINE_REACHED
      await sleeper.sleep(wait)
      continue
    }
    failures += 1
    const backoff = Math.min(retry.initialDelaySeconds * 2 ** (failures - 1), retry.maxDelaySeconds) * 1000
    await sleeper.sleep(Math.max(0, Math.min(backoff, left)))
  }
}
