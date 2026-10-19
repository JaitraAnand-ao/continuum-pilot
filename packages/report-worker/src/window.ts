/* The report window and the daily timetable, all in UTC (AC-1, AC-2, AC-5, AC-6). */

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const REPORT_DATE = /^\d{4}-\d{2}-\d{2}$/
/* An ISO 8601 instant with a time and a zone, as Graph writes createdDateTime. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export interface ReportWindow {
  reportDate: string
  /* Inclusive start, 00:00 UTC of D. */
  start: string
  /* Exclusive end, 00:00 UTC of D+1. */
  end: string
}

function startOf(reportDate: string): number {
  return Date.parse(`${parseReportDate(reportDate)}T00:00:00Z`)
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function midnight(ms: number): string {
  return `${dateOf(ms)}T00:00:00Z`
}

/* Returns the date unchanged when it is a real calendar day written YYYY-MM-DD. */
export function parseReportDate(reportDate: string): string {
  if (!REPORT_DATE.test(reportDate)) throw new RangeError(`not a YYYY-MM-DD report date: ${reportDate}`)
  const ms = Date.parse(`${reportDate}T00:00:00Z`)
  if (Number.isNaN(ms) || dateOf(ms) !== reportDate) throw new RangeError(`not a calendar day: ${reportDate}`)
  return reportDate
}

export function reportWindow(reportDate: string): ReportWindow {
  const start = startOf(reportDate)
  return { reportDate, start: midnight(start), end: midnight(start + DAY_MS) }
}

/* Graph may write seven fractional digits; Date.parse keeps milliseconds, which only ever
 * moves an instant earlier within the same millisecond and so never across a day edge. */
export function parseInstant(instant: string): number {
  const ms = INSTANT.test(instant) ? Date.parse(instant) : Number.NaN
  if (Number.isNaN(ms)) throw new RangeError(`not an ISO 8601 instant: ${instant}`)
  return ms
}

export function isWithinWindow(window: ReportWindow, instant: string): boolean {
  const ms = parseInstant(instant)
  return ms >= Date.parse(window.start) && ms < Date.parse(window.end)
}

/* The report date a run at `now` works on: the UTC day before. */
export function previousUtcDate(now: Date): string {
  return dateOf(now.getTime() - DAY_MS)
}

function onNextDayAt(reportDate: string, hours: number, minutes = 0): Date {
  return new Date(startOf(reportDate) + DAY_MS + hours * HOUR_MS + minutes * 60_000)
}

/* Collection stops retrying at 07:00 UTC on D+1. */
export function retryDeadline(reportDate: string): Date {
  return onNextDayAt(reportDate, 7)
}

/* Without a complete report by 07:30 UTC on D+1 the alarm fires. */
export function completeReportDueAt(reportDate: string): Date {
  return onNextDayAt(reportDate, 7, 30)
}

/* The report is promised by 08:00 UTC on D+1. */
export function publishDeadline(reportDate: string): Date {
  return onNextDayAt(reportDate, 8)
}

/* A run that starts after 07:00 UTC, a manual re-run or a backfill, still gets thirty
 * minutes of its own to collect instead of giving up before its first request. */
export function collectionDeadline(reportDate: string, now: Date): Date {
  const deadline = retryDeadline(reportDate)
  return now.getTime() < deadline.getTime() ? deadline : new Date(now.getTime() + 30 * 60_000)
}
