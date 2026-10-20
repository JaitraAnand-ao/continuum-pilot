import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryDay } from '../api/client'
import { FOCUS, type ViewState } from '../session/controller'
import { HISTORY_PAGE_PATH } from '../session/roles'
import { dailyReportPath, pageFor } from '../session/routes'
import { ADMIN_ONLY, READER } from '../testing/fixtures'
import { HISTORY, LATE_DATE, NO_REPORTS_YET, NOT_GENERATED_DATE } from '../testing/history'
import { all, byText, click, one, render, texts, type HostNode } from '../testing/tree'
import { View, type Actions } from '../screens/View'
import { HISTORY_FOCUS, HISTORY_TEXT, type HistoryActions, type HistoryState } from './controller'
import { dayLabel, dueLabel, monthLabel, rowName, utcTime } from './format'
import { ReportHistoryPage } from './ReportHistoryPage'

const october = HISTORY.items.filter((day) => day.reportDate.startsWith('2026-10'))
const months = ['2026-10', '2026-09', '2026-08', '2026-07']

const readyState = (patch: Partial<Extract<HistoryState, { phase: 'ready' }>> = {}): HistoryState => ({
  phase: 'ready',
  months,
  month: '2026-10',
  status: 'all',
  days: october,
  ...patch,
})

function historyActions() {
  return {
    retry: vi.fn(async () => undefined),
    setMonth: vi.fn(),
    setStatus: vi.fn(),
    previousMonth: vi.fn(),
    nextMonth: vi.fn(),
    clearFilter: vi.fn(),
  } satisfies HistoryActions
}

function page(state: HistoryState, actions = historyActions(), onOpenDay = vi.fn()) {
  return { tree: render(createElement(ReportHistoryPage, { state, actions, onOpenDay })), actions, onOpenDay }
}

const paragraphs = (tree: HostNode[]) => texts(tree, 'p')
const rows = (tree: HostNode[]) => all(tree, (node) => node.type === 'li' && node.props.className === 'history-row')
const rowFor = (tree: HostNode[], date: string) => {
  const found = rows(tree).find((row) => row.props['data-date'] === date)
  if (found === undefined) throw new Error(`no row for ${date}`)
  return found
}
const statusOf = (row: HostNode) => one([row], (node) => node.props.className === 'history-status__text').text

describe('Report history formatting', () => {
  it('names days, months, UTC times and rows as the story reads them', () => {
    expect(dayLabel('2026-10-11')).toBe('Sunday 11 October 2026')
    expect(dayLabel('2026-10-06')).toBe('Tuesday 6 October 2026')
    expect(monthLabel('2026-09')).toBe('September 2026')
    expect(utcTime('2026-10-15T07:42:00.000Z')).toBe('07:42 UTC')
    expect(utcTime('2026-10-15T09:42:00+02:00')).toBe('07:42 UTC')
    expect(dueLabel('2026-10-21T08:00:00.000Z')).toBe('Wednesday 21 October 2026 at 08:00 UTC')
    const day = (status: HistoryDay['status'], reportDate: string) =>
      ({ ...october[0], status, reportDate }) as HistoryDay
    expect(rowName(day('available', '2026-10-11'))).toBe('Sunday 11 October 2026, available')
    expect(rowName(day('generated_late', '2026-10-14'))).toBe('Wednesday 14 October 2026, generated late')
    expect(rowName(day('not_generated', '2026-10-06'))).toBe('Tuesday 6 October 2026, not generated')
  })
})

describe('Scenario: Every day shows its status and figures (AC-1)', () => {
  it('lists each October day with its status, sign-ins and failed counts exactly as the API sent them', () => {
    const { tree } = page(readyState())
    expect(rows(tree)).toHaveLength(18)
    for (const day of october) {
      const row = rowFor(tree, day.reportDate)
      const figures = texts([row], 'dd')
      expect(texts([row], 'dt')).toEqual(['Sign-ins', 'Failed'])
      expect(figures).toEqual(
        day.signIns === null ? ['—', '—'] : [day.signIns.toLocaleString('en-GB'), String(day.failed)],
      )
    }
    expect(texts([rowFor(tree, '2026-10-18')], 'dd')).toEqual(['1,200', '30'])
  })

  it('the late day reads Generated late with 07:42 UTC, with an icon beside the text', () => {
    const { tree } = page(readyState())
    const row = rowFor(tree, LATE_DATE)
    expect(statusOf(row)).toBe('Generated late')
    expect(one([row], (node) => node.props.className === 'history-status__time').text).toBe('07:42 UTC')
    const icon = one([row], (node) => node.props.className === 'history-status__icon')
    expect(icon.props['aria-hidden']).toBe('true')
    expect(icon.text).not.toBe('')
  })

  it('6 October reads Not generated, and available days read Available', () => {
    const { tree } = page(readyState())
    expect(statusOf(rowFor(tree, NOT_GENERATED_DATE))).toBe('Not generated')
    expect(statusOf(rowFor(tree, '2026-10-11'))).toBe('Available')
    expect(all([rowFor(tree, '2026-10-11')], (node) => node.props.className === 'history-status__time')).toEqual([])
  })

  it('notes that reports older than 90 days are deleted automatically', () => {
    const { tree } = page(readyState())
    expect(paragraphs(tree)).toContain('Reports older than 90 days are deleted automatically.')
    expect(HISTORY_TEXT.retention).toBe('Reports older than 90 days are deleted automatically.')
  })

  it('names the list after the month it shows', () => {
    const { tree } = page(readyState())
    expect(one(tree, (node) => node.type === 'ul').props['aria-label']).toBe('Days in October 2026')
  })
})

describe('Scenario: Opening a stored day (AC-2)', () => {
  it('the 11 October row is a link named Sunday 11 October 2026, available that opens its Daily report', () => {
    const { tree, onOpenDay } = page(readyState())
    const link = one([rowFor(tree, '2026-10-11')], (node) => node.type === 'a')
    expect(link.text).toBe('Sunday 11 October 2026, available')
    expect(link.props.href).toBe('/reports/daily?date=2026-10-11')
    click(link)
    expect(onOpenDay).toHaveBeenCalledWith('/reports/daily?date=2026-10-11')
  })

  it('a late row is a link named by its date and status', () => {
    const { tree } = page(readyState())
    expect(one([rowFor(tree, LATE_DATE)], (node) => node.type === 'a').text).toBe(
      'Wednesday 14 October 2026, generated late',
    )
  })

  it('the Daily report opens for that date', () => {
    expect(dailyReportPath('2026-10-11')).toBe('/reports/daily?date=2026-10-11')
    expect(pageFor('/reports/daily?date=2026-10-11')).toEqual({
      path: '/reports/daily?date=2026-10-11',
      heading: 'Daily report',
      requiresReader: true,
    })
  })
})

describe('Scenario: A day that was not generated is not a link (AC-2)', () => {
  it('the 6 October row is read as Tuesday 6 October 2026, not generated, and holds no link or focus stop', () => {
    const { tree } = page(readyState())
    const row = rowFor(tree, NOT_GENERATED_DATE)
    expect(all([row], (node) => node.type === 'a' || node.type === 'button')).toEqual([])
    expect(all([row], (node) => node.props.tabIndex !== undefined)).toEqual([])
    expect(one([row], (node) => node.props.className === 'history-row__date').text).toBe(
      'Tuesday 6 October 2026, not generated',
    )
  })

  it('every other October day is a link', () => {
    const { tree } = page(readyState())
    expect(all(tree, (node) => node.type === 'a')).toHaveLength(17)
  })
})

describe('Scenario: Filtering by status (AC-3)', () => {
  it('offers Month with every month in range and Status with each status, both labelled', () => {
    const { tree } = page(readyState())
    const month = one(tree, (node) => node.type === 'select' && node.props.id === HISTORY_FOCUS.month)
    const status = one(tree, (node) => node.type === 'select' && node.props.id === HISTORY_FOCUS.status)
    expect(texts([month], 'option')).toEqual(['October 2026', 'September 2026', 'August 2026', 'July 2026'])
    expect(month.props.value).toBe('2026-10')
    expect(texts([status], 'option')).toEqual(['All statuses', 'Available', 'Generated late', 'Not generated'])
    expect(status.props.value).toBe('all')
    expect(one(tree, byText('label', 'Month')).props.htmlFor).toBe(HISTORY_FOCUS.month)
    expect(one(tree, byText('label', 'Status')).props.htmlFor).toBe(HISTORY_FOCUS.status)
  })

  it('choosing a status or month hands the choice to the controller', () => {
    const { tree, actions } = page(readyState())
    const change = (id: string, value: string) =>
      (one(tree, (node) => node.props.id === id).props.onChange as (event: unknown) => void)({
        currentTarget: { value },
      })
    change(HISTORY_FOCUS.status, 'generated_late')
    change(HISTORY_FOCUS.month, '2026-09')
    expect(actions.setStatus).toHaveBeenCalledWith('generated_late')
    expect(actions.setMonth).toHaveBeenCalledWith('2026-09')
  })

  it('only the days the controller kept are listed', () => {
    const late = october.filter((day) => day.status === 'generated_late')
    const { tree } = page(readyState({ status: 'generated_late', days: late }))
    expect(rows(tree).map((row) => row.props['data-date'])).toEqual([LATE_DATE])
  })
})

describe('Previous month and Next month (AC-3)', () => {
  const button = (tree: HostNode[], name: string) => one(tree, byText('button', name))

  it('both move between months', () => {
    const { tree, actions } = page(readyState({ month: '2026-09', days: [] }))
    click(button(tree, 'Previous month'))
    click(button(tree, 'Next month'))
    expect(actions.previousMonth).toHaveBeenCalledTimes(1)
    expect(actions.nextMonth).toHaveBeenCalledTimes(1)
    expect(button(tree, 'Previous month').props['aria-disabled']).toBeUndefined()
    expect(button(tree, 'Next month').props['aria-disabled']).toBeUndefined()
  })

  it('Next month is aria-disabled, never natively disabled, on the newest month', () => {
    const { tree } = page(readyState())
    expect(button(tree, 'Next month').props['aria-disabled']).toBe('true')
    expect(button(tree, 'Next month').props.disabled).toBeUndefined()
  })

  it('Previous month is aria-disabled on the oldest month', () => {
    const { tree } = page(readyState({ month: '2026-07', days: [] }))
    expect(button(tree, 'Previous month').props['aria-disabled']).toBe('true')
    expect(button(tree, 'Previous month').props.disabled).toBeUndefined()
  })
})

describe('Scenario: A filter that matches nothing (AC-4)', () => {
  it('reads No days in September 2026 have the status Not generated and offers Clear filter', () => {
    const { tree, actions } = page(readyState({ month: '2026-09', status: 'not_generated', days: [] }))
    expect(paragraphs(tree)).toContain('No days in September 2026 have the status Not generated')
    expect(rows(tree)).toEqual([])
    click(one(tree, byText('button', 'Clear filter')))
    expect(actions.clearFilter).toHaveBeenCalledTimes(1)
  })

  it('offers no Clear filter while days are listed', () => {
    const { tree } = page(readyState())
    expect(all(tree, byText('button', 'Clear filter'))).toEqual([])
  })
})

describe('Scenario: Before the first report (AC-5)', () => {
  it('reads No reports yet and when the first report covers and is ready', () => {
    const { tree } = page({ phase: 'noReports', firstReportDueAt: NO_REPORTS_YET.firstReportDueAt })
    expect(one(tree, (node) => node.type === 'h2').text).toBe('No reports yet')
    expect(paragraphs(tree)).toEqual([
      'Reports older than 90 days are deleted automatically.',
      'The first report covers the first full UTC day after collection starts and is ready by 08:00 UTC the next morning.',
      'The first report is due Wednesday 21 October 2026 at 08:00 UTC.',
    ])
    expect(all(tree, (node) => node.type === 'select' || node.type === 'ul')).toEqual([])
  })

  it('leaves out the due line when the server sent none', () => {
    const { tree } = page({ phase: 'noReports', firstReportDueAt: null })
    expect(paragraphs(tree)).not.toContain(expect.stringMatching(/is due/))
  })
})

describe('Scenario: History is loading (AC-6)', () => {
  it('skeleton rows show Loading report history…, hidden from screen readers, in a busy region', () => {
    const { tree } = page({ phase: 'loading' })
    const region = one(tree, (node) => node.props['aria-busy'] === 'true')
    expect(texts([region], 'p')).toEqual(['Loading report history…'])
    const skeleton = one([region], (node) => node.type === 'ul')
    expect(skeleton.props['aria-hidden']).toBe('true')
    expect(all([skeleton], (node) => node.type === 'li').length).toBeGreaterThanOrEqual(3)
    expect(all(tree, (node) => node.type === 'a' || node.type === 'button')).toEqual([])
  })
})

describe('Scenario: History fails to load (AC-6)', () => {
  it('reads Couldn’t load report history with Retry and the Daily report date picker note', () => {
    const { tree, actions, onOpenDay } = page({ phase: 'failed', traceId: '5b8aa5a2d2c872e8321cf37308d69df2' })
    expect(one(tree, (node) => node.type === 'h2').text).toBe("Couldn't load report history")
    expect(paragraphs(tree)).toContain('You can still open a single day from the Daily report date picker.')
    expect(texts(tree, 'code')).toEqual(['5b8aa5a2d2c872e8321cf37308d69df2'])
    click(one(tree, byText('button', 'Retry')))
    expect(actions.retry).toHaveBeenCalledTimes(1)
    click(one(tree, byText('a', 'Open the Daily report')))
    expect(onOpenDay).toHaveBeenCalledWith('/reports/daily')
  })

  it('shows no reference when the request never reached the server', () => {
    const { tree } = page({ phase: 'failed', traceId: null })
    expect(texts(tree, 'code')).toEqual([])
  })
})

describe('Scenario: An administrator without the reader role is refused (AC-7)', () => {
  it('a 403 shows no days, only why', () => {
    const { tree } = page({ phase: 'forbidden' })
    expect(paragraphs(tree)).toEqual([HISTORY_TEXT.forbidden])
    expect(all(tree, (node) => node.type === 'ul' || node.type === 'select')).toEqual([])
  })

  it('renders nothing before the page has opened', () => {
    expect(page({ phase: 'idle' }).tree).toEqual([])
  })
})

describe('Report history inside the signed-in frame', () => {
  const base: ViewState = {
    screen: { name: 'app', me: READER, path: HISTORY_PAGE_PATH },
    idleWarning: false,
    signOutFailed: false,
    title: '',
    announcement: null,
    focus: null,
    focusRequest: 0,
  }
  const sessionActions = (): Actions => ({
    start: vi.fn(async () => undefined),
    signIn: vi.fn(),
    navigate: vi.fn(async () => undefined),
    staySignedIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    signInWithDifferentAccount: vi.fn(async () => undefined),
  })

  it('a reader sees the Report history heading, which takes focus, above the list', () => {
    const actions = sessionActions()
    const tree = render(
      createElement(View, { state: base, actions, history: { state: readyState(), actions: historyActions() } }),
    )
    const main = one(tree, (node) => node.type === 'main')
    const heading = one([main], (node) => node.type === 'h1')
    expect(heading.text).toBe('Report history')
    expect(heading.props.id).toBe(FOCUS.pageHeading)
    expect(rows([main])).toHaveLength(18)
    click(one([rowFor([main], '2026-10-11')], (node) => node.type === 'a'))
    expect(actions.navigate).toHaveBeenCalledWith('/reports/daily?date=2026-10-11')
  })

  it('an administrator without the reader role sees no history even if a state is present (AC-7)', () => {
    const tree = render(
      createElement(View, {
        state: { ...base, screen: { name: 'app', me: ADMIN_ONLY, path: HISTORY_PAGE_PATH } },
        actions: sessionActions(),
        history: { state: readyState(), actions: historyActions() },
      }),
    )
    expect(one(tree, (node) => node.type === 'h1').text).toBe("This page isn't available")
    expect(rows(tree)).toEqual([])
  })

  it('other pages show no history', () => {
    const tree = render(
      createElement(View, {
        state: { ...base, screen: { name: 'app', me: READER, path: '/reports/daily' } },
        actions: sessionActions(),
        history: { state: readyState(), actions: historyActions() },
      }),
    )
    expect(rows(tree)).toEqual([])
  })
})
