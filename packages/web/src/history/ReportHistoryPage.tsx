import type { ChangeEvent, MouseEvent } from 'react'
import type { HistoryDay, HistoryStatus } from '../api/client'
import { DAILY_REPORT_PATH } from '../session/roles'
import { dailyReportPath } from '../session/routes'
import {
  HISTORY_FOCUS,
  HISTORY_TEXT,
  noMatch,
  STATUS_FILTERS,
  statusFilterLabel,
  type HistoryActions,
  type HistoryState,
} from './controller'
import { dayLabel, dueLabel, figure, monthLabel, STATUS_LABEL, statusWords, utcTime } from './format'

export interface ReportHistoryPageProps {
  state: HistoryState
  actions: HistoryActions
  onOpenDay: (path: string) => void
}

/* Every status carries an icon as well as its words, so none relies on colour alone. */
const STATUS_ICON: Record<HistoryStatus, string> = {
  available: '✓',
  generated_late: '◷',
  not_generated: '✕',
}

const SKELETON_ROWS = 5

/* Modified clicks keep the browser's own behaviour, such as opening the day in a new tab. */
const followIn = (onOpenDay: (path: string) => void, path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  onOpenDay(path)
}

function HistoryRow({ day, onOpenDay }: { day: HistoryDay; onOpenDay: (path: string) => void }) {
  const path = dailyReportPath(day.reportDate)
  const name = (
    <>
      {dayLabel(day.reportDate)}
      <span className="visually-hidden">, {statusWords(day.status)}</span>
    </>
  )
  return (
    <li className="history-row" data-date={day.reportDate}>
      {/* AC-2: a stored day is a link named by its date and status; a day with no report is plain text. */}
      {day.status === 'not_generated' ? (
        <span className="history-row__date">{name}</span>
      ) : (
        <a className="history-row__date" href={path} onClick={followIn(onOpenDay, path)}>
          {name}
        </a>
      )}
      <span className={`history-status history-status--${day.status}`}>
        <span className="history-status__icon" aria-hidden="true">
          {STATUS_ICON[day.status]}
        </span>
        {/* The date already carries the status for screen readers; the late time is read here. */}
        <span className="history-status__text" aria-hidden="true">
          {STATUS_LABEL[day.status]}
        </span>
        {day.status === 'generated_late' && day.generatedAt !== null && (
          <>
            {' '}
            <span className="history-status__time">{utcTime(day.generatedAt)}</span>
          </>
        )}
      </span>
      <dl className="history-row__figures">
        <dt>Sign-ins</dt>
        <dd>{figure(day.signIns)}</dd>
        <dt>Failed</dt>
        <dd>{figure(day.failed)}</dd>
      </dl>
    </li>
  )
}

function Ready({
  state,
  actions,
  onOpenDay,
}: ReportHistoryPageProps & { state: Extract<HistoryState, { phase: 'ready' }> }) {
  const { months, month, status, days } = state
  const index = months.indexOf(month)
  const choose = (handler: (value: string) => void) => (event: ChangeEvent<HTMLSelectElement>) =>
    handler(event.currentTarget.value)
  return (
    <>
      <div className="history-filters">
        <label htmlFor={HISTORY_FOCUS.month}>Month</label>
        <select id={HISTORY_FOCUS.month} value={month} onChange={choose(actions.setMonth)}>
          {months.map((candidate) => (
            <option key={candidate} value={candidate}>
              {monthLabel(candidate)}
            </option>
          ))}
        </select>
        {/* Unavailable moves stay focusable and announce themselves as unavailable (aria-disabled). */}
        <button
          type="button"
          className="button"
          aria-disabled={index === months.length - 1 ? 'true' : undefined}
          onClick={actions.previousMonth}
        >
          Previous month
        </button>
        <button
          type="button"
          className="button"
          aria-disabled={index === 0 ? 'true' : undefined}
          onClick={actions.nextMonth}
        >
          Next month
        </button>
        <label htmlFor={HISTORY_FOCUS.status}>Status</label>
        <select id={HISTORY_FOCUS.status} value={status} onChange={choose(actions.setStatus)}>
          {STATUS_FILTERS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {statusFilterLabel(candidate)}
            </option>
          ))}
        </select>
      </div>
      {days.length === 0 ? (
        <div className="history-empty">
          <p>{noMatch(month, status)}</p>
          <button type="button" className="button" onClick={actions.clearFilter}>
            Clear filter
          </button>
        </div>
      ) : (
        <ul className="history-list" aria-label={`Days in ${monthLabel(month)}`}>
          {days.map((day) => (
            <HistoryRow key={day.reportDate} day={day} onOpenDay={onOpenDay} />
          ))}
        </ul>
      )}
    </>
  )
}

/* SCR-3: the page body under the Report history heading. Announcements go through the shared live
 * regions (the controller notifies the session), so nothing here is itself live. */
export function ReportHistoryPage(props: ReportHistoryPageProps) {
  const { state, actions, onOpenDay } = props
  switch (state.phase) {
    case 'idle':
      return null
    case 'forbidden':
      return <p>{HISTORY_TEXT.forbidden}</p>
    case 'loading':
      return (
        <div className="history" aria-busy="true">
          <p>{HISTORY_TEXT.loading}</p>
          <ul className="history-list history-list--skeleton" aria-hidden="true">
            {Array.from({ length: SKELETON_ROWS }, (_, row) => (
              <li key={row} className="history-row history-row--skeleton" />
            ))}
          </ul>
        </div>
      )
    case 'failed': {
      return (
        <div className="history history-error">
          <h2>{HISTORY_TEXT.failed}</h2>
          <p>{HISTORY_TEXT.failedHint}</p>
          <a href={DAILY_REPORT_PATH} onClick={followIn(onOpenDay, DAILY_REPORT_PATH)}>
            Open the Daily report
          </a>
          {state.traceId !== null && (
            <p>
              Error reference <code>{state.traceId}</code>
            </p>
          )}
          <button type="button" className="button button--primary" onClick={() => void actions.retry()}>
            Retry
          </button>
        </div>
      )
    }
    case 'noReports':
      return (
        <div className="history">
          <p>{HISTORY_TEXT.retention}</p>
          <h2>{HISTORY_TEXT.noReports}</h2>
          <p>{HISTORY_TEXT.firstReport}</p>
          {state.firstReportDueAt !== null && <p>The first report is due {dueLabel(state.firstReportDueAt)}.</p>}
        </div>
      )
    case 'ready':
      return (
        <div className="history">
          <p>{HISTORY_TEXT.retention}</p>
          <Ready {...props} state={state} />
        </div>
      )
  }
}
