import { vi } from 'vitest'
import type { MeResult } from '../src/api/client'
import { SessionController, type Api, type Clock, type Navigation } from '../src/session/controller'
import { SIGNED_IN_AT } from './fixtures'

/* A controller wired to fakes: a scripted IF-4/IF-5, an address bar and a clock we move by hand. */
export function harness(pathname = '/', search = '') {
  const answers: MeResult[] = []
  const api = {
    getMe: vi.fn<Api['getMe']>(async () => answers.shift() ?? { status: 'error' }),
    logout: vi.fn<Api['logout']>(async () => true),
  }
  const address = { pathname, search }
  const nav = {
    pathname: () => address.pathname,
    search: () => address.search,
    assign: vi.fn<Navigation['assign']>(),
    replace: vi.fn<Navigation['replace']>((path: string) => {
      address.pathname = path
      address.search = ''
    }),
  }
  let now = SIGNED_IN_AT
  let pending: { at: number; callback: () => void; handle: number } | undefined
  let handles = 0
  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      pending = { at: now + ms, callback, handle: ++handles }
      return pending.handle
    },
    clearTimeout: (handle) => {
      if (pending?.handle === handle) pending = undefined
    },
  }
  const controller = new SessionController(api, nav, clock)
  return {
    controller,
    api,
    nav,
    address,
    answer: (...results: MeResult[]) => answers.push(...results),
    /* Moves the clock forward, firing the session timer each time it falls due. */
    advance(ms: number) {
      const until = now + ms
      while (pending && pending.at <= until) {
        const due = pending
        pending = undefined
        now = due.at
        due.callback()
      }
      now = until
    },
    timerPending: () => pending !== undefined,
  }
}
