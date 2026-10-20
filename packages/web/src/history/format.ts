/* How Report history writes the server's dates and times: always in UTC, the words the story uses. */
import type { HistoryDay, HistoryStatus } from '../api/client'

export const STATUS_LABEL: Record<HistoryStatus, string> = {
  available: 'Available',
  generated_late: 'Generated late',
  not_generated: 'Not generated',
}

const part = (format: Intl.DateTimeFormat, date: Date, type: Intl.DateTimeFormatPartTypes): string =>
  format.formatToParts(date).find((candidate) => candidate.type === type)?.value ?? ''

const DAY = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

const utcDate = (value: string): Date => new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value)

/* 'Sunday 11 October 2026', assembled from parts so no locale punctuation creeps in. */
export function dayLabel(value: string): string {
  const date = utcDate(value)
  return ['weekday', 'day', 'month', 'year']
    .map((type) => part(DAY, date, type as Intl.DateTimeFormatPartTypes))
    .join(' ')
}

/* 'October 2026' for the YYYY-MM the contract uses. */
export function monthLabel(month: string): string {
  const date = utcDate(`${month}-01`)
  return `${part(DAY, date, 'month')} ${part(DAY, date, 'year')}`
}

/* '07:42 UTC'. */
export const utcTime = (value: string): string => `${new Date(value).toISOString().slice(11, 16)} UTC`

/* 'Wednesday 21 October 2026 at 08:00 UTC'. */
export const dueLabel = (value: string): string => `${dayLabel(value)} at ${utcTime(value)}`

/* The name a screen reader gives a row: 'Sunday 11 October 2026, available'. */
export const rowName = (day: HistoryDay): string => `${dayLabel(day.reportDate)}, ${statusWords(day.status)}`

export const statusWords = (status: HistoryStatus): string => STATUS_LABEL[status].toLowerCase()

const COUNT = new Intl.NumberFormat('en-GB')

/* A figure the server sent, or a dash where it sent none. */
export const figure = (value: number | null): string => (value === null ? '—' : COUNT.format(value))
