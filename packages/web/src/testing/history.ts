/* Payloads shaped exactly as contracts/IF-27.json answers; contract.test.ts validates each one. */
import type { HistoryDay, ReportHistory } from '../api/client'

const DAY = 24 * 60 * 60 * 1000
/* The newest day in range is yesterday (UTC) relative to the fixtures' NOW of 2026-10-19 08:00. */
const NEWEST = Date.parse('2026-10-18T00:00:00.000Z')

export const LATE_DATE = '2026-10-14'
export const NOT_GENERATED_DATE = '2026-10-06'

/* 90 days, newest first: every day Available, except 14 October (late, 07:42 UTC) and 6 October (not generated). */
export function ninetyDays(): HistoryDay[] {
  return Array.from({ length: 90 }, (_, index) => {
    const reportDate = new Date(NEWEST - index * DAY).toISOString().slice(0, 10)
    if (reportDate === NOT_GENERATED_DATE) {
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
    const nextMorning = new Date(Date.parse(`${reportDate}T00:00:00.000Z`) + DAY).toISOString().slice(0, 10)
    return {
      reportDate,
      status: reportDate === LATE_DATE ? 'generated_late' : 'available',
      generatedAt: `${nextMorning}T${reportDate === LATE_DATE ? '07:42:00.000Z' : '05:10:00.000Z'}`,
      signIns: 1200 + index,
      failed: 30 + (index % 7),
      flagCount: null,
      emailedAt: null,
    }
  })
}

export const HISTORY: ReportHistory = { totalDays: 90, firstReportDueAt: null, items: ninetyDays() }

export const NO_REPORTS_YET: ReportHistory = {
  totalDays: 0,
  firstReportDueAt: '2026-10-21T08:00:00.000Z',
  items: [],
}

export const BAD_REQUEST = {
  type: '/problems/invalid-request',
  title: 'month or status is invalid.',
  status: 400,
  traceId: '5b8aa5a2d2c872e8321cf37308d69df2',
}

export const NOT_A_READER = {
  type: '/problems/forbidden',
  title: 'The session lacks the reader role.',
  status: 403,
  traceId: '2c1f6a7e9d3b4c5a8e7f6d5c4b3a2918',
}
