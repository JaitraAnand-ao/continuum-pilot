import { sql } from 'drizzle-orm'
import { guarded, type Database } from './client.js'
import { reportNotGenerated, reports, type ReportStatus } from './schema.js'

/* A stored report as Report history lists it: its figures and when it was published, never its snapshot evidence.
 * Instants are the stored values as UTC ISO strings to the millisecond, so the route serves them unchanged.
 * Whether it was late, and the days with no row at all, are decided by the caller from these stored values. */
export interface HistoryReportDay {
  kind: 'report'
  reportDate: string
  status: ReportStatus
  total: number
  successful: number
  failed: number
  publishedAt: string
}

export interface HistoryNotGeneratedDay {
  kind: 'not_generated'
  reportDate: string
  recordedAt: string
}

export type HistoryDay = HistoryReportDay | HistoryNotGeneratedDay

export interface ReportHistory {
  /* Every stored day from `from` to `to`, both inclusive UTC dates (YYYY-MM-DD), newest first. A day that was
   * recorded as not generated and later published is listed once, as its report. */
  list(range: { from: string; to: string }): Promise<HistoryDay[]>
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

function calendarDate(value: string): string {
  if (
    !CALENDAR_DATE.test(value) ||
    value < '0001-01-01' ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError('report history bound is not a calendar date')
  }
  return value
}

const UTC_ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'

type Row = {
  kind: HistoryDay['kind']
  report_date: string
  status: ReportStatus | null
  total: number | null
  successful: number | null
  failed: number | null
  at: string
}

export function createReportHistory(db: Database): ReportHistory {
  const store = guarded({
    async list(from: string, to: string): Promise<HistoryDay[]> {
      const { rows } = await db.execute<Row>(sql`
        SELECT 'report' AS kind, ${reports.reportDate}::text AS report_date, ${reports.status} AS status,
               ${reports.total} AS total, ${reports.successful} AS successful, ${reports.failed} AS failed,
               to_char(${reports.publishedAt} AT TIME ZONE 'UTC', ${UTC_ISO}) AS at
          FROM ${reports}
         WHERE ${reports.reportDate} BETWEEN ${from}::date AND ${to}::date
        UNION ALL
        SELECT 'not_generated', ${reportNotGenerated.reportDate}::text, NULL, NULL, NULL, NULL,
               to_char(${reportNotGenerated.recordedAt} AT TIME ZONE 'UTC', ${UTC_ISO})
          FROM ${reportNotGenerated}
         WHERE ${reportNotGenerated.reportDate} BETWEEN ${from}::date AND ${to}::date
           AND NOT EXISTS (SELECT 1 FROM ${reports} WHERE ${reports.reportDate} = ${reportNotGenerated.reportDate})
        ORDER BY report_date DESC`)
      return rows.map((row): HistoryDay =>
        row.kind === 'report'
          ? {
              kind: 'report',
              reportDate: row.report_date,
              status: row.status as ReportStatus,
              total: Number(row.total),
              successful: Number(row.successful),
              failed: Number(row.failed),
              publishedAt: row.at,
            }
          : { kind: 'not_generated', reportDate: row.report_date, recordedAt: row.at },
      )
    },
  })
  return {
    async list({ from, to }) {
      if (calendarDate(from) > calendarDate(to)) throw new RangeError('report history range ends before it starts')
      return store.list(from, to)
    },
  }
}
