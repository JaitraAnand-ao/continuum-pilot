/* The report store as Report history reads it (IF-6, IF-16): the published rows and not-generated days in a date range,
 * and when collection started. The Postgres adapter lands with CMP-5; routes depend only on this port. */
import type { StoredDays } from './rules.js'

export type { StoredDays, StoredReportSummary } from './rules.js'

export interface ReportHistoryStore {
  /* Rows whose report_date lies in [from, to], both inclusive, as YYYY-MM-DD. publishedAt is ISO 8601 UTC. */
  listDays(range: { from: string; to: string }): Promise<StoredDays>
  /* null until the first collection run has started. */
  collectionStartedAt(): Promise<Date | null>
}
