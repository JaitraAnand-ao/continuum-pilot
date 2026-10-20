import type { NotGeneratedDay, PublishedReport, RiskDetection, SignIn, SourceId } from './model.js'
import type { PublishResult, ReportStore } from './ports.js'

/* The executor pg-boss exposes through boss.getDb(), so the worker shares one pool with its queue. */
export interface SqlExecutor {
  executeSql(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

const SELECT_REPORT = `
  SELECT report_date::text AS report_date,
         to_char(window_start AT TIME ZONE 'UTC', ${UTC_ISO}) AS window_start,
         to_char(window_end AT TIME ZONE 'UTC', ${UTC_ISO}) AS window_end,
         status, missing_sources, total, successful, failed, snapshot, content_hash,
         to_char(published_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS published_at
    FROM report
   WHERE report_date = $1::date`

/* One statement, so the report row and its snapshot are written together or not at all. */
const INSERT_REPORT = `
  WITH inserted AS (
    INSERT INTO report (report_date, window_start, window_end, status, missing_sources,
                        total, successful, failed, snapshot, content_hash, published_at)
    VALUES ($1::date, $2::timestamptz, $3::timestamptz, $4, $5::text[], $6, $7, $8, $9::jsonb, $10, $11::timestamptz)
    ON CONFLICT (report_date) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int AS created FROM inserted`

const SELECT_NOT_GENERATED = `
  SELECT report_date::text AS report_date, missing_sources,
         to_char(recorded_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS recorded_at
    FROM report_not_generated
   WHERE report_date = $1::date`

const UPSERT_NOT_GENERATED = `
  INSERT INTO report_not_generated (report_date, missing_sources, recorded_at)
  VALUES ($1::date, $2::text[], $3::timestamptz)
  ON CONFLICT (report_date) DO UPDATE
    SET missing_sources = EXCLUDED.missing_sources, recorded_at = EXCLUDED.recorded_at`

export class PgReportStore implements ReportStore {
  constructor(private readonly db: SqlExecutor) {}

  async findReport(reportDate: string): Promise<PublishedReport | undefined> {
    const { rows } = await this.db.executeSql(SELECT_REPORT, [reportDate])
    const row = rows[0]
    if (!row) return undefined
    const snapshot = row.snapshot as { signIns: SignIn[]; riskDetections: RiskDetection[] }
    return {
      reportDate: row.report_date as string,
      windowStart: row.window_start as string,
      windowEnd: row.window_end as string,
      status: row.status as PublishedReport['status'],
      missingSources: row.missing_sources as SourceId[],
      totals: { total: row.total as number, successful: row.successful as number, failed: row.failed as number },
      signIns: snapshot.signIns,
      riskDetections: snapshot.riskDetections,
      contentHash: row.content_hash as string,
      publishedAt: row.published_at as string,
    }
  }

  async publish(report: PublishedReport): Promise<PublishResult> {
    const { rows } = await this.db.executeSql(INSERT_REPORT, [
      report.reportDate,
      report.windowStart,
      report.windowEnd,
      report.status,
      report.missingSources,
      report.totals.total,
      report.totals.successful,
      report.totals.failed,
      JSON.stringify({ signIns: report.signIns, riskDetections: report.riskDetections }),
      report.contentHash,
      report.publishedAt,
    ])
    if (rows[0]?.created === 1) return { created: true, report }
    return { created: false, report: (await this.findReport(report.reportDate)) as PublishedReport }
  }

  async findNotGenerated(reportDate: string): Promise<NotGeneratedDay | undefined> {
    const { rows } = await this.db.executeSql(SELECT_NOT_GENERATED, [reportDate])
    const row = rows[0]
    if (!row) return undefined
    return {
      reportDate: row.report_date as string,
      missingSources: row.missing_sources as SourceId[],
      recordedAt: row.recorded_at as string,
    }
  }

  async recordNotGenerated(day: NotGeneratedDay): Promise<void> {
    await this.db.executeSql(UPSERT_NOT_GENERATED, [day.reportDate, day.missingSources, day.recordedAt])
  }
}
