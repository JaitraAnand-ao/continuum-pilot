import type { Clock } from './clock.js'
import type { MetricsSink } from './ports.js'

export const METRIC_NAMESPACE = 'SigninReports/ReportWorker'
/* 1 when the run left a complete report for the day, 0 when incomplete or not generated. */
export const REPORT_COMPLETE = 'ReportComplete'
/* Emitted at 07:30 UTC; the 'no report by 07:30 UTC' alarm fires on 1 (or on no data). */
export const COMPLETE_REPORT_MISSING = 'CompleteReportMissing'
export const SIGN_INS_COLLECTED = 'SignInsCollected'

/* CloudWatch embedded metric format: one JSON line per value, picked up from stdout by the
 * log driver. Properties carry only report dates and counts, never sign-in content. */
export function createEmfMetricsSink(write: (line: string) => void, clock: Clock): MetricsSink {
  return {
    emit(name, value, properties = {}) {
      write(
        JSON.stringify({
          _aws: {
            Timestamp: clock.now().getTime(),
            CloudWatchMetrics: [
              { Namespace: METRIC_NAMESPACE, Dimensions: [[]], Metrics: [{ Name: name, Unit: 'Count' }] },
            ],
          },
          ...properties,
          [name]: value,
        }),
      )
    },
  }
}
