import type { Clock } from './clock.js'
import { COMPLETE_REPORT_MISSING } from './metrics.js'
import type { MetricsSink, ReportStore } from './ports.js'
import { previousUtcDate } from './rules.js'

export interface DeadlineCheckDeps {
  clock: Clock
  store: ReportStore
  metrics: MetricsSink
}

/* Runs at 07:30 UTC: reports 1 to the alarm unless a complete report for yesterday is published (AC-6). */
export async function checkReportDeadline(deps: DeadlineCheckDeps): Promise<{ reportDate: string; missing: boolean }> {
  const reportDate = previousUtcDate(deps.clock.now())
  const report = await deps.store.findPublished(reportDate)
  const missing = report?.complete !== true
  deps.metrics.emit(COMPLETE_REPORT_MISSING, missing ? 1 : 0, { reportDate })
  return { reportDate, missing }
}
