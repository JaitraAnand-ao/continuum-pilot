import { METRIC_NAMESPACE, METRICS } from './generate.js'
import type { MetricSink } from './ports.js'
import type { ReportStore } from './store.js'

export interface CheckDeps {
  store: ReportStore
  metrics: MetricSink
}

/**
 * report.check at 07:30 UTC on D+1: CompleteReportMissing is 1 unless a complete report for
 * D is published. The 'no report by 07:30 UTC' CloudWatch alarm watches this metric.
 */
export async function checkReportPresence(
  deps: CheckDeps,
  reportDate: string,
): Promise<{ reportDate: string; complete: boolean }> {
  const report = await deps.store.findPublished(reportDate)
  const complete = report?.complete === true
  await deps.metrics.put({
    namespace: METRIC_NAMESPACE,
    name: METRICS.completeReportMissing,
    value: complete ? 0 : 1,
    dimensions: {},
  })
  return { reportDate, complete }
}
