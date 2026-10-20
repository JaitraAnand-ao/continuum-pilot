import type { ReportWindow } from './model.js'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const REPORT_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isReportDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = REPORT_DATE.exec(value)
  if (!match) return false
  const [, year, month, day] = match.map(Number) as [number, number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function startOf(reportDate: string): number {
  return Date.parse(`${reportDate}T00:00:00.000Z`)
}

/* 00:00 UTC of D up to but not including 00:00 UTC of D+1. */
export function windowFor(reportDate: string): ReportWindow {
  const start = startOf(reportDate)
  return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() }
}

export function windowContains(window: ReportWindow, instant: string): boolean {
  const at = Date.parse(instant)
  return at >= Date.parse(window.start) && at < Date.parse(window.end)
}

export function previousUtcDay(now: Date): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return new Date(today - DAY_MS).toISOString().slice(0, 10)
}

function onNextDay(reportDate: string, hours: number): Date {
  return new Date(startOf(reportDate) + DAY_MS + hours * HOUR_MS)
}

/* After 07:00 UTC on D+1 nothing more is fetched from Graph. */
export function retryDeadline(reportDate: string): Date {
  return onNextDay(reportDate, 7)
}

export function alarmCheckTime(reportDate: string): Date {
  return onNextDay(reportDate, 7.5)
}

export function publishDeadline(reportDate: string): Date {
  return onNextDay(reportDate, 8)
}
