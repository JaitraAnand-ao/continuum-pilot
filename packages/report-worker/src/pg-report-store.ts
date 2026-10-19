import type { PublishedReport, ReportDraft, ReportStore } from './ports.js'
import type { RiskDetection, SignIn } from './sign-in.js'

/* The executeSql shape pg-boss's getDb() returns, so the worker shares the job pool. */
export interface Db {
  executeSql(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

const REPORT_COLUMNS = `id::text AS id, report_date::text AS report_date, window_start, window_end, complete,
  missing_sources, total_count, successful_count, failed_count, content_hash, published_at`

const iso = (value: unknown) => new Date(value as string | Date).toISOString()

function toReport(row: Record<string, unknown>): PublishedReport {
  return {
    id: row.id as string,
    reportDate: row.report_date as string,
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    complete: row.complete as boolean,
    missingSources: row.missing_sources as string[],
    totals: {
      total: row.total_count as number,
      successful: row.successful_count as number,
      failed: row.failed_count as number,
    },
    contentHash: row.content_hash as string,
    publishedAt: iso(row.published_at),
  }
}

/* Every statement is a constant with bound parameters; the publish is one statement, so the
 * report row and its whole snapshot commit together or not at all, and only ever by INSERT. */
export function createPgReportStore(db: Db): ReportStore & {
  listPublished(): Promise<PublishedReport[]>
  loadSnapshot(reportId: string): Promise<{ signIns: SignIn[]; riskDetections: RiskDetection[] }>
  isRecordedNotGenerated(reportDate: string): Promise<boolean>
} {
  const findPublished = async (reportDate: string) => {
    const { rows } = await db.executeSql(`SELECT ${REPORT_COLUMNS} FROM report WHERE report_date = $1::date`, [
      reportDate,
    ])
    return rows[0] ? toReport(rows[0]) : undefined
  }
  return {
    findPublished,
    async publish(draft: ReportDraft, publishedAt: Date) {
      const { rows } = await db.executeSql(
        `WITH inserted AS (
           INSERT INTO report (report_date, window_start, window_end, complete, missing_sources,
             total_count, successful_count, failed_count, content_hash, published_at)
           VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (report_date) DO NOTHING
           RETURNING *),
         sign_ins AS (
           INSERT INTO report_sign_in (report_id, sign_in_id, sign_in_type, created_at, error_code, record)
           SELECT inserted.id, s.record->>'id', s.record->>'type', (s.record->>'createdAt')::timestamptz,
             (s.record->>'errorCode')::integer, s.record
           FROM inserted, jsonb_array_elements($11::jsonb) AS s(record)),
         risks AS (
           INSERT INTO report_risk_detection (report_id, detection_id, detected_at, record)
           SELECT inserted.id, r.record->>'id', (r.record->>'detectedAt')::timestamptz, r.record
           FROM inserted, jsonb_array_elements($12::jsonb) AS r(record))
         SELECT ${REPORT_COLUMNS} FROM inserted`,
        [
          draft.reportDate,
          draft.windowStart,
          draft.windowEnd,
          draft.complete,
          draft.missingSources,
          draft.totals.total,
          draft.totals.successful,
          draft.totals.failed,
          draft.contentHash,
          publishedAt.toISOString(),
          JSON.stringify(draft.signIns),
          JSON.stringify(draft.riskDetections),
        ],
      )
      if (rows[0]) return { report: toReport(rows[0]), created: true }
      /* Another run published first; its report stands. */
      return { report: (await findPublished(draft.reportDate)) as PublishedReport, created: false }
    },
    async recordNotGenerated(reportDate, missingSources, recordedAt) {
      await db.executeSql(
        `INSERT INTO report_not_generated (report_date, missing_sources, recorded_at) VALUES ($1::date, $2, $3)
         ON CONFLICT (report_date) DO NOTHING`,
        [reportDate, missingSources, recordedAt.toISOString()],
      )
    },
    async listPublished() {
      const { rows } = await db.executeSql(`SELECT ${REPORT_COLUMNS} FROM report ORDER BY report_date`, [])
      return rows.map(toReport)
    },
    async loadSnapshot(reportId) {
      const signIns = await db.executeSql(
        `SELECT record FROM report_sign_in WHERE report_id = $1::uuid ORDER BY sign_in_id`,
        [reportId],
      )
      const risks = await db.executeSql(
        `SELECT record FROM report_risk_detection WHERE report_id = $1::uuid ORDER BY detection_id`,
        [reportId],
      )
      return {
        signIns: signIns.rows.map((row) => row.record as SignIn),
        riskDetections: risks.rows.map((row) => row.record as RiskDetection),
      }
    },
    async isRecordedNotGenerated(reportDate) {
      const { rows } = await db.executeSql(`SELECT 1 FROM report_not_generated WHERE report_date = $1::date`, [
        reportDate,
      ])
      return rows.length > 0
    },
  }
}
