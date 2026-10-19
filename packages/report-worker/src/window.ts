/* The report window rules: D is a UTC calendar day, half-open [D 00:00Z, D+1 00:00Z). */

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface ReportWindow {
  readonly reportDate: string
  readonly start: Date
  readonly end: Date
}

function startOf(reportDate: string): number {
  const start = DATE_PATTERN.test(reportDate) ? Date.parse(`${reportDate}T00:00:00.000Z`) : NaN
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== reportDate) {
    throw new RangeError('report date must be a calendar date written YYYY-MM-DD')
  }
  return start
}

export function isReportDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    startOf(value)
    return true
  } catch {
    return false
  }
}

export function windowFor(reportDate: string): ReportWindow {
  const start = startOf(reportDate)
  return { reportDate, start: new Date(start), end: new Date(start + DAY_MS) }
}

export function inWindow(window: ReportWindow, instant: Date): boolean {
  const at = instant.getTime()
  return at >= window.start.getTime() && at < window.end.getTime()
}

export function previousUtcDay(now: Date): string {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  return new Date(today - DAY_MS).toISOString().slice(0, 10)
}

/** Graph retries stop here: 07:00 UTC on D+1. */
export function retryDeadline(reportDate: string): Date {
  return new Date(startOf(reportDate) + DAY_MS + 7 * HOUR_MS)
}

/** The 'no report by 07:30 UTC' check runs here. */
export function alarmCheckAt(reportDate: string): Date {
  return new Date(startOf(reportDate) + DAY_MS + 7.5 * HOUR_MS)
}

/** The report must be published before 08:00 UTC on D+1. */
export function publishDeadline(reportDate: string): Date {
  return new Date(startOf(reportDate) + DAY_MS + 8 * HOUR_MS)
}
