import { METRIC_NAMESPACE, type Clock, type MetricsPort, type ReportStore } from './ports.js'

/* Run at 07:30 UTC on D+1: emits CompleteReportMissing = 1 unless a complete report for D is stored.
 * The 'no report by 07:30 UTC' CloudWatch alarm watches this metric. Returns whether it is missing. */
export async function checkCompleteReport(
  reportDate: string,
  deps: { store: ReportStore; metrics: MetricsPort; clock: Clock },
): Promise<boolean> {
  const report = await deps.store.findReport(reportDate)
  const missing = report?.status !== 'complete'
  await deps.metrics.put({
    namespace: METRIC_NAMESPACE,
    name: 'CompleteReportMissing',
    value: missing ? 1 : 0,
    dimensions: {},
    timestamp: deps.clock.now().toISOString(),
  })
  return missing
}
