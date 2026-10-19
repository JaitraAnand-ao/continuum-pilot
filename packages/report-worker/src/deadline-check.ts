/* report.deadline-check, run at 07:30 UTC: emits CompleteReportMissing for the previous UTC
 * day, 1 without a complete published report and 0 with one (AC-6). The alarm treats
 * missing data as breaching, so a worker that never runs this also alarms. */
import type { Clock } from './clock.js'
import { COMPLETE_REPORT_MISSING_METRIC, METRIC_NAMESPACE } from './metrics.js'
import type { MetricsSink, ReportStore } from './ports.js'
import { completeReportDueAt, previousUtcDate } from './window.js'

export type DeadlineCheckResult =
  | { status: 'checked'; reportDate: string; completeReportMissing: boolean }
  | { status: 'too-early'; reportDate: string }

export async function checkCompleteReport({
  clock,
  store,
  metrics,
}: {
  clock: Clock
  store: ReportStore
  metrics: MetricsSink
}): Promise<DeadlineCheckResult> {
  const now = clock.now()
  const reportDate = previousUtcDate(now)
  if (now.getTime() < completeReportDueAt(reportDate).getTime()) return { status: 'too-early', reportDate }
  const report = await store.findPublished(reportDate)
  const completeReportMissing = report?.completeness !== 'complete'
  await metrics.put({
    namespace: METRIC_NAMESPACE,
    name: COMPLETE_REPORT_MISSING_METRIC,
    value: completeReportMissing ? 1 : 0,
    unit: 'Count',
  })
  return { status: 'checked', reportDate, completeReportMissing }
}
