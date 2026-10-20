/* Stands in for the report store (IF-6, IF-16): stored report rows, not-generated days and when collection started. */
import type { ReportHistoryStore, StoredDays, StoredReportSummary } from '../../src/history/store.js'

export class FakeReportHistoryStore implements ReportHistoryStore {
  reports: StoredReportSummary[] = []
  notGenerated: string[] = []
  startedAt: Date | null = new Date('2026-07-01T09:15:00.000Z')
  failure: Error | null = null
  readonly ranges: { from: string; to: string }[] = []

  async listDays(range: { from: string; to: string }): Promise<StoredDays> {
    this.ranges.push(range)
    if (this.failure) throw this.failure
    return {
      reports: this.reports.filter((row) => row.reportDate >= range.from && row.reportDate <= range.to),
      notGenerated: this.notGenerated.filter((day) => day >= range.from && day <= range.to),
    }
  }

  async collectionStartedAt(): Promise<Date | null> {
    if (this.failure) throw this.failure
    return this.startedAt
  }
}
