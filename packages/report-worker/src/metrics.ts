/* The metrics the CloudWatch alarms watch, written as Embedded Metric Format log lines so
 * the awslogs driver turns them into metrics without a CloudWatch client in the worker. */
import type { Clock } from './clock.js'
import type { MetricsSink } from './ports.js'

export const METRIC_NAMESPACE = 'SigninReports'
export const REPORT_PUBLISHED_METRIC = 'ReportPublished'
export const REPORT_INCOMPLETE_METRIC = 'ReportIncomplete'
export const REPORT_NOT_GENERATED_METRIC = 'ReportNotGenerated'
/* The 'no report by 07:30 UTC' alarm watches this one (AC-6). */
export const COMPLETE_REPORT_MISSING_METRIC = 'CompleteReportMissing'

export function emfMetricsSink({ clock, write }: { clock: Clock; write: (line: string) => void }): MetricsSink {
  return {
    async put({ namespace, name, value, unit }) {
      const line = {
        _aws: {
          Timestamp: clock.now().getTime(),
          CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: name, Unit: unit }] }],
        },
        [name]: value,
      }
      write(`${JSON.stringify(line)}\n`)
    },
  }
}
