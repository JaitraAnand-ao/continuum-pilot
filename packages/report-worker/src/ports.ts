/* The ports the job writes through: the report store and the metrics sink. */
import type { ReportContent } from './report.js'
import type { ReportSource } from './signins.js'

export interface PublishedReport extends ReportContent {
  contentHash: string
  publishedAt: string
}

export interface NotGeneratedRecord {
  reportDate: string
  status: 'not-generated'
  missingSources: ReportSource[]
  missingSourceLabels: string[]
  recordedAt: string
}

export interface ReportStore {
  findPublished(reportDate: string): Promise<PublishedReport | null>
  /* Inserts in one transaction unless a report for the date is already published, in which
   * case it changes nothing and returns the stored one. Publishing clears a not-generated
   * record for the date. */
  publish(report: PublishedReport): Promise<{ created: boolean; report: PublishedReport }>
  recordNotGenerated(record: NotGeneratedRecord): Promise<void>
}

export interface MetricDatum {
  namespace: string
  name: string
  value: number
  unit: 'Count'
}

export interface MetricsSink {
  put(datum: MetricDatum): Promise<void>
}
