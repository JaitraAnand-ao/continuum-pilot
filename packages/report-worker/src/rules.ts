import type { ReportWindow, Totals } from './ports.js'
import type { SignIn } from './sign-in.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/* Collection keeps retrying until 07:00 UTC on D+1 (AC-5). */
export const RETRY_DEADLINE_OFFSET_MS = 7 * HOUR_MS
/* The no-complete-report alarm is evaluated at 07:30 UTC on D+1 (AC-6). */
export const ALARM_CHECK_OFFSET_MS = 7.5 * HOUR_MS
/* A report is due by 08:00 UTC on D+1 (AC-1). */
export const PUBLISH_DEADLINE_OFFSET_MS = 8 * HOUR_MS

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function parseReportDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw new Error('report date must be YYYY-MM-DD')
  const midnight = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== value) {
    throw new Error('report date is not a calendar date')
  }
  return value
}

/* 00:00 UTC of D up to but not including 00:00 UTC of D+1. */
export function reportWindow(reportDate: string): ReportWindow {
  const start = new Date(`${parseReportDate(reportDate)}T00:00:00.000Z`)
  return { start, end: new Date(start.getTime() + DAY_MS) }
}

export function previousUtcDate(now: Date): string {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  return new Date(today - DAY_MS).toISOString().slice(0, 10)
}

export function isInWindow(instant: string, window: ReportWindow): boolean {
  const at = new Date(instant).getTime()
  return at >= window.start.getTime() && at < window.end.getTime()
}

/* A day can only be reported once it is over. */
export function isReportable(reportDate: string, now: Date): boolean {
  return now.getTime() >= reportWindow(reportDate).end.getTime()
}

export function retryDeadline(reportDate: string): Date {
  return new Date(reportWindow(reportDate).end.getTime() + RETRY_DEADLINE_OFFSET_MS)
}

export function alarmCheckTime(reportDate: string): Date {
  return new Date(reportWindow(reportDate).end.getTime() + ALARM_CHECK_OFFSET_MS)
}

export function publishDeadline(reportDate: string): Date {
  return new Date(reportWindow(reportDate).end.getTime() + PUBLISH_DEADLINE_OFFSET_MS)
}

export function totalsOf(signIns: readonly SignIn[]): Totals {
  const successful = signIns.filter((signIn) => signIn.errorCode === 0).length
  return { total: signIns.length, successful, failed: signIns.length - successful }
}

export type Completeness = 'complete' | 'incomplete' | 'not-generated'

/* Without a single sign-in type there is nothing to report; any other gap is published, marked incomplete. */
export function assessCompleteness(
  missingSignInTypes: number,
  signInTypeCount: number,
  missingRisk: boolean,
): Completeness {
  if (missingSignInTypes >= signInTypeCount) return 'not-generated'
  return missingSignInTypes > 0 || missingRisk ? 'incomplete' : 'complete'
}
