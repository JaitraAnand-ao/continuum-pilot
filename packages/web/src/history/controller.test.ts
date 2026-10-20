import { describe, expect, it, vi } from 'vitest'
import type { HistoryApi, HistoryResult } from '../api/client'
import { FOCUS, SessionController, type Navigator } from '../session/controller'
import { HISTORY_PAGE_PATH } from '../session/roles'
import { ADMIN_ONLY, READER } from '../testing/fixtures'
import { HISTORY, LATE_DATE, NO_REPORTS_YET, NOT_GENERATED_DATE } from '../testing/history'
import { followHistoryPage, HISTORY_FOCUS, HISTORY_TEXT, HistoryController, type HistoryPort } from './controller'

const ok = (history = HISTORY): HistoryResult => ({ kind: 'ok', history })

function setup(answers: HistoryResult[] = [ok()]) {
  const api = { getReportHistory: vi.fn(async () => answers.shift() ?? ok()) } satisfies HistoryApi
  const session = { notify: vi.fn(), recheck: vi.fn(async () => undefined) } satisfies HistoryPort
  const history = new HistoryController({ api, session })
  const listener = vi.fn()
  history.subscribe(listener)
  return { history, api, session, listener, state: history.getState }
}

function ready(state: ReturnType<HistoryController['getState']>) {
  if (state.phase !== 'ready') throw new Error(`expected ready, got ${state.phase}`)
  return state
}

const lastNotice = (session: { notify: ReturnType<typeof vi.fn> }) => session.notify.mock.calls.at(-1)

describe('Feature: See the last 90 days of reports at a glance in Report history', () => {
  describe('Scenario: Every day shows its status and figures (AC-1)', () => {
    it('Given reports for October 2026, When I open Report history, Then the newest month lists each of its days from the API', async () => {
      const { history, api, state, session } = setup()
      await history.open()
      expect(api.getReportHistory).toHaveBeenCalledTimes(1)
      const view = ready(state())
      expect(view.month).toBe('2026-10')
      expect(view.status).toBe('all')
      expect(view.days).toEqual(HISTORY.items.filter((day) => day.reportDate.startsWith('2026-10')))
      expect(view.days).toHaveLength(18)
      expect(lastNotice(session)).toEqual([null, { politeness: 'polite', text: '18 days shown' }])
    })

    it('offers every month in the 90 days, newest first, taken from the days the API returned', async () => {
      const { history, state } = setup()
      await history.open()
      expect(ready(state()).months).toEqual(['2026-10', '2026-09', '2026-08', '2026-07'])
    })

    it('the late day and the not-generated day keep the server’s status and figures', async () => {
      const { history, state } = setup()
      await history.open()
      const days = ready(state()).days
      expect(days.find((day) => day.reportDate === LATE_DATE)).toEqual(
        HISTORY.items.find((day) => day.reportDate === LATE_DATE),
      )
      expect(days.find((day) => day.reportDate === NOT_GENERATED_DATE)?.status).toBe('not_generated')
    })
  })

  describe('Scenario: Filtering by status (AC-3)', () => {
    it('Given October 2026, When I set Status to Generated late, Then only late days are listed and the count is announced politely', async () => {
      const { history, state, session } = setup()
      await history.open()
      history.setStatus('generated_late')
      const view = ready(state())
      expect(view.status).toBe('generated_late')
      expect(view.days.map((day) => day.reportDate)).toEqual([LATE_DATE])
      expect(lastNotice(session)).toEqual([null, { politeness: 'polite', text: '1 day shown' }])
    })

    it('ignores a status the contract does not define', async () => {
      const { history, state, session } = setup()
      await history.open()
      const calls = session.notify.mock.calls.length
      history.setStatus('bogus')
      expect(ready(state()).status).toBe('all')
      expect(session.notify).toHaveBeenCalledTimes(calls)
    })
  })

  describe('Month filter and Previous month / Next month (AC-3)', () => {
    it('setting Month shows that month and announces how many days are shown', async () => {
      const { history, state, session } = setup()
      await history.open()
      history.setMonth('2026-09')
      const view = ready(state())
      expect(view.month).toBe('2026-09')
      expect(view.days).toHaveLength(30)
      expect(lastNotice(session)).toEqual([null, { politeness: 'polite', text: '30 days shown' }])
    })

    it('ignores a month outside the 90 days', async () => {
      const { history, state } = setup()
      await history.open()
      history.setMonth('2025-01')
      expect(ready(state()).month).toBe('2026-10')
    })

    it('Previous month moves to the older month and Next month back, stopping at either end', async () => {
      const { history, state, session } = setup()
      await history.open()
      history.nextMonth()
      expect(ready(state()).month).toBe('2026-10')
      history.previousMonth()
      expect(ready(state()).month).toBe('2026-09')
      history.previousMonth()
      history.previousMonth()
      expect(ready(state()).month).toBe('2026-07')
      const calls = session.notify.mock.calls.length
      history.previousMonth()
      expect(ready(state()).month).toBe('2026-07')
      expect(session.notify).toHaveBeenCalledTimes(calls)
      history.nextMonth()
      expect(ready(state()).month).toBe('2026-08')
      expect(lastNotice(session)).toEqual([null, { politeness: 'polite', text: '31 days shown' }])
    })

    it('keeps the status filter when the month changes', async () => {
      const { history, state } = setup()
      await history.open()
      history.setStatus('not_generated')
      history.previousMonth()
      const view = ready(state())
      expect(view.status).toBe('not_generated')
      expect(view.days).toEqual([])
    })
  })

  describe('Scenario: A filter that matches nothing (AC-4)', () => {
    it('Given no September day was not generated, When I set Month to September 2026 and Status to Not generated, Then the empty message is announced', async () => {
      const { history, state, session } = setup()
      await history.open()
      history.setMonth('2026-09')
      history.setStatus('not_generated')
      expect(ready(state()).days).toEqual([])
      expect(lastNotice(session)).toEqual([
        null,
        { politeness: 'polite', text: 'No days in September 2026 have the status Not generated' },
      ])
    })

    it('Clear filter shows every status again, moves focus to Status and announces the count', async () => {
      const { history, state, session } = setup()
      await history.open()
      history.setMonth('2026-09')
      history.setStatus('not_generated')
      history.clearFilter()
      const view = ready(state())
      expect(view.status).toBe('all')
      expect(view.month).toBe('2026-09')
      expect(view.days).toHaveLength(30)
      expect(lastNotice(session)).toEqual([HISTORY_FOCUS.status, { politeness: 'polite', text: '30 days shown' }])
    })
  })

  describe('Scenario: Before the first report (AC-5)', () => {
    it('Given no report exists, When I open Report history, Then it reads No reports yet with when the first is due', async () => {
      const { history, state, session } = setup([ok(NO_REPORTS_YET)])
      await history.open()
      expect(state()).toEqual({ phase: 'noReports', firstReportDueAt: NO_REPORTS_YET.firstReportDueAt })
      expect(lastNotice(session)).toEqual([null, { politeness: 'polite', text: HISTORY_TEXT.noReports }])
    })

    it('an empty range without a due time still reads No reports yet', async () => {
      const { history, state } = setup([ok({ totalDays: 0, firstReportDueAt: null, items: [] })])
      await history.open()
      expect(state()).toEqual({ phase: 'noReports', firstReportDueAt: null })
    })
  })

  describe('Scenario: History is loading (AC-6)', () => {
    it('Given the endpoint is slow, When I open Report history, Then it is loading until the answer arrives', async () => {
      let answer: (result: HistoryResult) => void = () => undefined
      const api = { getReportHistory: vi.fn(() => new Promise<HistoryResult>((resolve) => (answer = resolve))) }
      const session = { notify: vi.fn(), recheck: vi.fn(async () => undefined) }
      const history = new HistoryController({ api, session })
      const opening = history.open()
      expect(history.getState()).toEqual({ phase: 'loading' })
      expect(session.notify).toHaveBeenLastCalledWith(null, { politeness: 'polite', text: HISTORY_TEXT.loading })
      answer(ok())
      await opening
      expect(history.getState().phase).toBe('ready')
    })
  })

  describe('Scenario: History fails to load (AC-6)', () => {
    it('Given the endpoint fails, When I open Report history, Then it reads Couldn’t load report history, assertively', async () => {
      const { history, state, session } = setup([{ kind: 'failed', status: 503, traceId: 'abc' }])
      await history.open()
      expect(state()).toEqual({ phase: 'failed', traceId: 'abc' })
      expect(lastNotice(session)).toEqual([null, { politeness: 'assertive', text: HISTORY_TEXT.failed }])
    })

    it('Retry asks again and moves focus to the page heading while it loads', async () => {
      const { history, state, session, api } = setup([{ kind: 'failed', status: null, traceId: null }, ok()])
      await history.open()
      const retrying = history.retry()
      expect(session.notify).toHaveBeenLastCalledWith(FOCUS.pageHeading, {
        politeness: 'polite',
        text: HISTORY_TEXT.loading,
      })
      await retrying
      expect(api.getReportHistory).toHaveBeenCalledTimes(2)
      expect(ready(state()).days).toHaveLength(18)
    })
  })

  describe('Scenario: An administrator without the reader role is refused (AC-7)', () => {
    it('a 403 from the history endpoint shows no days and says why', async () => {
      const { history, state, session } = setup([{ kind: 'forbidden' }])
      await history.open()
      expect(state()).toEqual({ phase: 'forbidden' })
      expect(lastNotice(session)).toEqual([null, { politeness: 'assertive', text: HISTORY_TEXT.forbidden }])
    })
  })

  describe('session and stale answers', () => {
    it('a 401 hands back to the session check, which returns to Sign in', async () => {
      const { history, session, state } = setup([{ kind: 'unauthenticated' }])
      await history.open()
      expect(session.recheck).toHaveBeenCalledTimes(1)
      expect(state()).toEqual({ phase: 'idle' })
    })

    it('an answer arriving after the page was left is ignored', async () => {
      let answer: (result: HistoryResult) => void = () => undefined
      const api = { getReportHistory: vi.fn(() => new Promise<HistoryResult>((resolve) => (answer = resolve))) }
      const session = { notify: vi.fn(), recheck: vi.fn(async () => undefined) }
      const history = new HistoryController({ api, session })
      const opening = history.open()
      history.close()
      answer(ok())
      await opening
      expect(history.getState()).toEqual({ phase: 'idle' })
    })

    it('filters do nothing until days have loaded', () => {
      const { history, session, listener } = setup()
      history.setMonth('2026-10')
      history.setStatus('available')
      history.previousMonth()
      history.nextMonth()
      history.clearFilter()
      expect(session.notify).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
    })

    it('unsubscribing stops notifications', async () => {
      const { history } = setup()
      const listener = vi.fn()
      const unsubscribe = history.subscribe(listener)
      unsubscribe()
      await history.open()
      expect(listener).not.toHaveBeenCalled()
    })
  })
})

describe('followHistoryPage', () => {
  function wire(me = READER, path = HISTORY_PAGE_PATH) {
    let location = path
    const navigator = {
      path: () => location,
      search: () => '',
      push: vi.fn((next: string) => (location = next)),
      replace: vi.fn((next: string) => (location = next)),
      assign: vi.fn(),
    } satisfies Navigator
    const session = new SessionController({
      api: { getMe: vi.fn(async () => ({ kind: 'ok' as const, me })), signOut: vi.fn(async () => true) },
      navigator,
      clock: { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn() },
    })
    const history = { open: vi.fn(async () => undefined), close: vi.fn() }
    const stop = followHistoryPage(session, history)
    return { session, history, stop }
  }

  it('opens the history once when a reader lands on Report history', async () => {
    const { session, history } = wire()
    await session.start()
    expect(history.open).toHaveBeenCalledTimes(1)
  })

  it('closes it when the reader moves to another page, and opens it again on return', async () => {
    const { session, history } = wire()
    await session.start()
    await session.navigate('/reports/daily')
    expect(history.close).toHaveBeenCalledTimes(1)
    await session.navigate(HISTORY_PAGE_PATH)
    expect(history.open).toHaveBeenCalledTimes(2)
  })

  it('never opens it for an administrator without the reader role (AC-7)', async () => {
    const { session, history } = wire(ADMIN_ONLY)
    await session.start()
    expect(history.open).not.toHaveBeenCalled()
  })

  it('stops following once disconnected', async () => {
    const { session, history, stop } = wire()
    stop()
    await session.start()
    expect(history.open).not.toHaveBeenCalled()
  })
})

describe('SessionController.notify', () => {
  it('moves focus and speaks through the shared live regions for a page’s own controller', () => {
    const session = new SessionController({
      api: { getMe: vi.fn(), signOut: vi.fn() },
      navigator: { path: () => '/', search: () => '', push: vi.fn(), replace: vi.fn(), assign: vi.fn() },
      clock: { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn() },
    })
    const before = session.getState().focusRequest
    session.notify(HISTORY_FOCUS.status, { politeness: 'polite', text: '3 days shown' })
    expect(session.getState().focus).toBe(HISTORY_FOCUS.status)
    expect(session.getState().focusRequest).toBe(before + 1)
    expect(session.getState().announcement).toMatchObject({ politeness: 'polite', text: '3 days shown' })
    session.notify(null, null)
    expect(session.getState().focusRequest).toBe(before + 1)
  })
})
