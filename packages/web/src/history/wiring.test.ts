/* Regressions found in review: the real controllers wired together as main.tsx wires them. */
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createApi, type HistoryApi, type MeResult } from '../api/client'
import { SessionController, type Navigator } from '../session/controller'
import { HISTORY_PAGE_PATH } from '../session/roles'
import { json, READER } from '../testing/fixtures'
import { HISTORY, LATE_DATE } from '../testing/history'
import { all, one, render } from '../testing/tree'
import { AppShell } from '../screens/AppShell'
import { followHistoryPage, HistoryController, type HistoryState } from './controller'
import { ReportHistoryPage } from './ReportHistoryPage'

function wire(path = HISTORY_PAGE_PATH) {
  let location = path
  const navigator = {
    path: () => location,
    search: () => '',
    push: vi.fn((next: string) => (location = next)),
    replace: vi.fn((next: string) => (location = next)),
    assign: vi.fn(),
  } satisfies Navigator
  const session = new SessionController({
    api: { getMe: vi.fn(async (): Promise<MeResult> => ({ kind: 'ok', me: READER })), signOut: vi.fn() },
    navigator,
    clock: { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn() },
  })
  const api = { getReportHistory: vi.fn(async () => ({ kind: 'ok' as const, history: HISTORY })) } satisfies HistoryApi
  const history = new HistoryController({
    api,
    session: { notify: session.notify, recheck: session.staySignedIn },
  })
  followHistoryPage(session, history)
  return { session, history, api }
}

describe('Report history wired to the real session', () => {
  it('opening Report history asks the API once and shows the days, with the count in the polite region', async () => {
    const { session, history, api } = wire()
    await session.start()
    await vi.waitFor(() => expect(history.getState().phase).toBe('ready'))
    expect(api.getReportHistory).toHaveBeenCalledTimes(1)
    expect(session.getState().announcement).toMatchObject({ politeness: 'polite', text: '18 days shown' })
  })

  it('Clear filter asks the session to focus Status and announce the count', async () => {
    const { session, history } = wire()
    await session.start()
    await vi.waitFor(() => expect(history.getState().phase).toBe('ready'))
    history.setStatus('not_generated')
    history.setMonth('2026-09')
    history.clearFilter()
    expect(session.getState().focus).toBe('history-status')
    expect(session.getState().announcement).toMatchObject({ text: '30 days shown' })
  })
})

describe('row links', () => {
  const actions = {
    retry: vi.fn(async () => undefined),
    setMonth: vi.fn(),
    setStatus: vi.fn(),
    previousMonth: vi.fn(),
    nextMonth: vi.fn(),
    clearFilter: vi.fn(),
  }
  const october = HISTORY.items.filter((day) => day.reportDate.startsWith('2026-10'))
  const state: HistoryState = { phase: 'ready', months: ['2026-10'], month: '2026-10', status: 'all', days: october }

  it('a modified click keeps the browser’s behaviour, such as a new tab', () => {
    const onOpenDay = vi.fn()
    const tree = render(createElement(ReportHistoryPage, { state, actions, onOpenDay }))
    const link = all(tree, (node) => node.type === 'a')[0]
    const preventDefault = vi.fn()
    ;(link?.props.onClick as (event: object) => void)({ ctrlKey: true, preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(onOpenDay).not.toHaveBeenCalled()
  })

  it('the late status and its time are separated, and the status words are not read twice', () => {
    const tree = render(createElement(ReportHistoryPage, { state, actions, onOpenDay: vi.fn() }))
    const row = one(tree, (node) => node.props['data-date'] === LATE_DATE)
    expect(one([row], (node) => node.props.className === 'history-status history-status--generated_late').text).toBe(
      '◷Generated late 07:42 UTC',
    )
    expect(one([row], (node) => node.props.className === 'history-status__text').props['aria-hidden']).toBe('true')
  })

  it('the Daily report link stays current when it opens a stored day', () => {
    const tree = render(
      createElement(AppShell, {
        me: READER,
        path: '/reports/daily?date=2026-10-11',
        signOutFailed: false,
        onNavigate: vi.fn(),
        onSignOut: vi.fn(),
      }),
    )
    const daily = one(tree, (node) => node.type === 'a' && node.text === 'Daily report')
    expect(daily.props['aria-current']).toBe('page')
  })
})

describe('getReportHistory body shape', () => {
  it('a 200 whose body is not a history is a failure, not a crash later', async () => {
    expect(await createApi(async () => json(200, { items: null })).getReportHistory()).toEqual({
      kind: 'failed',
      status: 200,
      traceId: null,
    })
  })
})
