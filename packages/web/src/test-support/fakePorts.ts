import { vi } from 'vitest'
import type { ApiClient, MeResult } from '../api/client'
import type { FocusTarget, Ports } from '../session/controller'
import { SIGNED_IN_AT } from './fixtures'

export interface Timer {
  ms: number
  task: () => void
  cancelled: boolean
}

export interface FakePorts extends Ports {
  api: ApiClient & { getMe: ReturnType<typeof vi.fn>; signOut: ReturnType<typeof vi.fn> }
  titles: string[]
  focused: FocusTarget[]
  urls: string[]
  assigned: string[]
  timers: Timer[]
  clock: { now: number }
  /* Moves the clock forward and runs every live timer that falls due. */
  advance(ms: number): void
}

export function fakePorts(pathname = '/', search = '', results: MeResult[] = []): FakePorts {
  const queue = [...results]
  const clock = { now: SIGNED_IN_AT }
  const timers: Timer[] = []
  const ports: FakePorts = {
    api: {
      getMe: vi.fn(async (): Promise<MeResult> => queue.shift() ?? { status: 'unavailable' }),
      signOut: vi.fn(async () => undefined),
    },
    location: { pathname, search },
    titles: [],
    focused: [],
    urls: [],
    assigned: [],
    timers,
    clock,
    replaceUrl: (path) => {
      ports.urls.push(path)
      ports.location = { pathname: path, search: '' }
    },
    assign: (url) => ports.assigned.push(url),
    setTitle: (title) => ports.titles.push(title),
    focus: (target) => ports.focused.push(target),
    schedule: (ms, task) => {
      const timer: Timer = { ms: clock.now + ms, task, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    now: () => clock.now,
    advance(ms) {
      clock.now += ms
      for (const timer of [...timers]) {
        if (!timer.cancelled && timer.ms <= clock.now) {
          timer.cancelled = true
          timer.task()
        }
      }
    },
  }
  return ports
}
