/* SCR-3 Report history (ST-7). Framework-free like the session controller: the page renders its state.
 * Every day, status and figure is the server's; the only client-side work is choosing which of the
 * server's days to show, by comparing the server's own reportDate and status values. */
import type { HistoryApi, HistoryDay, HistoryStatus } from '../api/client'
import { FOCUS, type Announcement, type SessionController } from '../session/controller'
import { isReader, HISTORY_PAGE_PATH } from '../session/roles'
import { monthLabel, STATUS_LABEL } from './format'

export type StatusFilter = 'all' | HistoryStatus

export type HistoryState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'failed'; traceId: string | null }
  | { phase: 'forbidden' }
  | { phase: 'noReports'; firstReportDueAt: string | null }
  | { phase: 'ready'; months: string[]; month: string; status: StatusFilter; days: HistoryDay[] }

/* What the history needs from the session: focus and the shared live regions, and a fresh check of
 * the session when the API says it has ended. */
export interface HistoryPort {
  notify(focus: string | null, announcement: Omit<Announcement, 'id'> | null): void
  recheck(): Promise<void>
}

export const HISTORY_FOCUS = {
  month: 'history-month',
  status: 'history-status',
} as const

export const HISTORY_TEXT = {
  loading: 'Loading report history…',
  failed: "Couldn't load report history",
  failedHint: 'You can still open a single day from the Daily report date picker.',
  noReports: 'No reports yet',
  firstReport:
    'The first report covers the first full UTC day after collection starts and is ready by 08:00 UTC the next morning.',
  retention: 'Reports older than 90 days are deleted automatically.',
  forbidden: 'Report history is only available to the reader group.',
} as const

export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'available', 'generated_late', 'not_generated']

export const statusFilterLabel = (status: StatusFilter): string =>
  status === 'all' ? 'All statuses' : STATUS_LABEL[status]

export const daysShown = (count: number): string => (count === 1 ? '1 day shown' : `${count} days shown`)

export const noMatch = (month: string, status: StatusFilter): string =>
  `No days in ${monthLabel(month)} have the status ${statusFilterLabel(status)}`

export type HistoryActions = Pick<
  HistoryController,
  'retry' | 'setMonth' | 'setStatus' | 'previousMonth' | 'nextMonth' | 'clearFilter'
>

const isStatusFilter = (value: string): value is StatusFilter => (STATUS_FILTERS as readonly string[]).includes(value)

export class HistoryController {
  private state: HistoryState = { phase: 'idle' }
  private items: HistoryDay[] = []
  private months: string[] = []
  private readonly listeners = new Set<() => void>()
  /* Answers that arrive after a newer request or after leaving the page are ignored. */
  private generation = 0

  constructor(private readonly deps: { api: HistoryApi; session: HistoryPort }) {}

  getState = (): HistoryState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  open = (): Promise<void> => this.load(null)

  /* The Retry button disappears while loading, so focus goes back to the page heading. */
  retry = (): Promise<void> => this.load(FOCUS.pageHeading)

  close = (): void => {
    this.generation += 1
    this.items = []
    this.months = []
    this.set({ phase: 'idle' })
  }

  setMonth = (month: string): void => {
    const { state } = this
    if (state.phase !== 'ready' || !state.months.includes(month)) return
    this.show(month, state.status, null)
  }

  setStatus = (status: string): void => {
    const { state } = this
    if (state.phase !== 'ready' || !isStatusFilter(status)) return
    this.show(state.month, status, null)
  }

  /* Months run newest first, so the previous (older) month is the next one in the list. */
  previousMonth = (): void => this.step(1)

  nextMonth = (): void => this.step(-1)

  /* The Clear filter button disappears with the empty message, so focus goes to Status. */
  clearFilter = (): void => {
    const { state } = this
    if (state.phase !== 'ready') return
    this.show(state.month, 'all', HISTORY_FOCUS.status)
  }

  private step(offset: number): void {
    const { state } = this
    if (state.phase !== 'ready') return
    const month = state.months[state.months.indexOf(state.month) + offset]
    if (month !== undefined) this.show(month, state.status, null)
  }

  private async load(focus: string | null): Promise<void> {
    const generation = ++this.generation
    const { session } = this.deps
    this.set({ phase: 'loading' })
    session.notify(focus, { politeness: 'polite', text: HISTORY_TEXT.loading })
    const result = await this.deps.api.getReportHistory()
    if (generation !== this.generation) return
    switch (result.kind) {
      case 'ok': {
        const { items, firstReportDueAt } = result.history
        if (firstReportDueAt !== null || items.length === 0) {
          this.set({ phase: 'noReports', firstReportDueAt })
          session.notify(null, { politeness: 'polite', text: HISTORY_TEXT.noReports })
          return
        }
        this.items = items
        this.months = [...new Set(items.map((day) => day.reportDate.slice(0, 7)))].sort().reverse()
        this.show(this.months[0] as string, 'all', null)
        return
      }
      case 'unauthenticated':
        this.set({ phase: 'idle' })
        await session.recheck()
        return
      case 'forbidden':
        this.set({ phase: 'forbidden' })
        session.notify(null, { politeness: 'assertive', text: HISTORY_TEXT.forbidden })
        return
      case 'failed':
        this.set({ phase: 'failed', traceId: result.traceId })
        session.notify(null, { politeness: 'assertive', text: HISTORY_TEXT.failed })
    }
  }

  private show(month: string, status: StatusFilter, focus: string | null): void {
    const days = this.items.filter(
      (day) => day.reportDate.startsWith(`${month}-`) && (status === 'all' || day.status === status),
    )
    this.set({ phase: 'ready', months: this.months, month, status, days })
    this.deps.session.notify(focus, {
      politeness: 'polite',
      text: days.length === 0 ? noMatch(month, status) : daysShown(days.length),
    })
  }

  private set(state: HistoryState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

/* Opens the history when a reader arrives on Report history and closes it when they leave. */
export function followHistoryPage(
  session: Pick<SessionController, 'subscribe' | 'getState'>,
  history: Pick<HistoryController, 'open' | 'close'>,
): () => void {
  let showing = false
  return session.subscribe(() => {
    const { screen } = session.getState()
    const shown = screen.name === 'app' && screen.path === HISTORY_PAGE_PATH && isReader(screen.me.roles)
    /* Record the change first: opening notifies the session, which calls back into this listener. */
    const was = showing
    showing = shown
    if (shown && !was) void history.open()
    if (!shown && was) history.close()
  })
}
