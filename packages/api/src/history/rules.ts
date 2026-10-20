/* ST-7: which days Report history lists and how each reads, decided on an injected instant and never on the clock.
 * The report worker generates D from 02:00 UTC on D+1, retries Graph until 07:00 and checks at 07:30 that a report is
 * stored; a report stored after that check reads Generated late. A report is promised by 08:00 UTC on D+1 (AC-5). */

export const HISTORY_DAYS = 90
export const DAY_STATUSES = ['available', 'generated_late', 'not_generated'] as const
export type DayStatus = (typeof DAY_STATUSES)[number]

/* A stored report's row as published; the figures are served as stored, never recomputed. */
export interface StoredReportSummary {
  reportDate: string
  publishedAt: string
  total: number
  failed: number
}

export interface StoredDays {
  reports: StoredReportSummary[]
  notGenerated: string[]
}

export interface HistoryDay {
  reportDate: string
  status: DayStatus
  generatedAt: string | null
  signIns: number | null
  failed: number | null
  /* Filled by ST-13 (flags) and ST-21 (email); null until then. */
  flagCount: number | null
  emailedAt: string | null
}

export interface History {
  items: HistoryDay[]
  totalDays: number
  firstReportDueAt: string | null
}

export interface HistoryFilter {
  month?: string
  status?: DayStatus
}

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const ON_TIME_AFTER_DAY_MS = (7 * 60 + 30) * MINUTE_MS
const DUE_AFTER_DAY_MS = 8 * 60 * MINUTE_MS

function startOf(reportDate: string): number {
  return Date.parse(`${reportDate}T00:00:00.000Z`)
}

function dateOf(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10)
}

function shift(reportDate: string, days: number): string {
  return dateOf(startOf(reportDate) + days * DAY_MS)
}

/* The 90 UTC days before today: today is still being collected, so the newest listed day is yesterday. */
export function historyRange(now: Date): { from: string; to: string } {
  const today = dateOf(now.getTime())
  return { from: shift(today, -HISTORY_DAYS), to: shift(today, -1) }
}

/* The first UTC day collection covered from its 00:00:00.000: the start day itself only when started exactly then. */
export function firstFullDay(collectionStartedAt: Date): string {
  const day = dateOf(collectionStartedAt.getTime())
  return startOf(day) === collectionStartedAt.getTime() ? day : shift(day, 1)
}

export function reportDueAt(reportDate: string): Date {
  return new Date(startOf(reportDate) + DAY_MS + DUE_AFTER_DAY_MS)
}

export function onTimeUntil(reportDate: string): Date {
  return new Date(startOf(reportDate) + DAY_MS + ON_TIME_AFTER_DAY_MS)
}

export function reportStatus(report: StoredReportSummary): Exclude<DayStatus, 'not_generated'> {
  return Date.parse(report.publishedAt) <= onTimeUntil(report.reportDate).getTime() ? 'available' : 'generated_late'
}

function stored(report: StoredReportSummary): HistoryDay {
  return {
    reportDate: report.reportDate,
    status: reportStatus(report),
    /* Throws on an unreadable instant rather than serving it; an ISO 8601 UTC value comes back unchanged. */
    generatedAt: new Date(report.publishedAt).toISOString(),
    signIns: report.total,
    failed: report.failed,
    flagCount: null,
    emailedAt: null,
  }
}

function notGenerated(reportDate: string): HistoryDay {
  return {
    reportDate,
    status: 'not_generated',
    generatedAt: null,
    signIns: null,
    failed: null,
    flagCount: null,
    emailedAt: null,
  }
}

/* When the first report is due: that of collection's first full day, or, once that has passed without a report, of the
 * next day whose 08:00 UTC deadline is still ahead, so the time given is never in the past. */
function nextDueAt(firstDay: string, now: Date): Date {
  const today = dateOf(now.getTime())
  const yesterday = shift(today, -1)
  const next = now.getTime() >= reportDueAt(yesterday).getTime() ? today : yesterday
  return reportDueAt(firstDay > next ? firstDay : next)
}

/* Every day of the range, newest first. A day with a stored report shows it; a day recorded as not generated, or
 * collected for but still without a report once it was due, reads Not generated; a day before collection's first
 * full day, or not yet due, is not listed. */
export function buildHistory(days: StoredDays, collectionStartedAt: Date | null, now: Date): History {
  const { from, to } = historyRange(now)
  const reports = new Map(days.reports.map((report) => [report.reportDate, report]))
  const recordedNotGenerated = new Set(days.notGenerated)
  const firstDay = collectionStartedAt === null ? null : firstFullDay(collectionStartedAt)
  const items: HistoryDay[] = []
  for (let day = to; day >= from; day = shift(day, -1)) {
    const report = reports.get(day)
    if (report) items.push(stored(report))
    else if (
      recordedNotGenerated.has(day) ||
      (firstDay !== null && day >= firstDay && now.getTime() >= reportDueAt(day).getTime())
    ) {
      items.push(notGenerated(day))
    }
  }
  const anyReport = items.some((item) => item.status !== 'not_generated')
  return {
    items,
    totalDays: items.length,
    firstReportDueAt: anyReport || firstDay === null ? null : nextDueAt(firstDay, now).toISOString(),
  }
}

/* Month and Status narrow the list; totalDays still counts the whole range so the UI can tell 'no match' from 'empty'. */
export function filterHistory(history: History, filter: HistoryFilter): History {
  const items = history.items.filter(
    (item) =>
      (filter.month === undefined || item.reportDate.startsWith(`${filter.month}-`)) &&
      (filter.status === undefined || item.status === filter.status),
  )
  return { ...history, items }
}
