import { describe, expect, it } from 'vitest'
import { alarmState, type Alarm, type Series } from './support/metric-math'
import { loadModule, readContract, resource } from './support/terraform'

/* @story:ST-2 @AC-6 — If no complete report exists for D at 07:30 UTC, a CloudWatch alarm fires. */

const mod = loadModule()
const contract = readContract()
const lag = contract.metrics.completeReportLag
const alarm = resource(mod, 'aws_cloudwatch_metric_alarm', 'no_complete_report_by_0730') as unknown as Alarm &
  Record<string, unknown>

const MINUTE = 60_000
const DAY = 86_400_000

/* What the report worker emits once a minute: whole UTC days between today and the latest complete report's date. */
function emitted(from: Date, to: Date, latestComplete: (now: Date) => string | undefined): Series {
  const series: Series = new Map()
  for (let t = from.getTime(); t <= to.getTime(); t += MINUTE) {
    const latest = latestComplete(new Date(t))
    const today = Math.floor(t / DAY) * DAY
    series.set(t, latest === undefined ? 99 : (today - Date.parse(`${latest}T00:00:00Z`)) / DAY)
  }
  return series
}

const metricQueryId = () => (alarm.metric_query.find((q) => q.metric)?.id ?? '') as string

function stateAt(iso: string, series: Series) {
  return alarmState(alarm, new Date(iso), { [metricQueryId()]: series })
}

describe('the worker metric contract the alarm watches', () => {
  it('declares the lag gauge the report worker emits, once a minute', () => {
    expect(contract.namespace).toBe('SigninReports')
    expect(lag).toMatchObject({
      name: 'CompleteReportLagDays',
      unit: 'Count',
      dimensions: { Service: 'report-worker' },
      periodSeconds: 60,
    })
  })

  it('watches exactly that metric, namespace and dimension', () => {
    const metrics = alarm.metric_query.filter((q) => q.metric)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]?.metric).toEqual({
      namespace: contract.namespace,
      metric_name: lag?.name,
      dimensions: lag?.dimensions,
      period: lag?.periodSeconds,
      stat: 'Maximum',
    })
  })

  it("is named for the 'no report by 07:30 UTC' condition and notifies the encrypted alarm topic", () => {
    expect(alarm.alarm_name).toBe('signin-reports-no-complete-report-by-0730-utc')
    expect(alarm.alarm_actions).toEqual(['${aws_sns_topic.alarms.arn}'])
    expect(alarm.ok_actions).toEqual(['${aws_sns_topic.alarms.arn}'])
    expect(resource(mod, 'aws_sns_topic', 'alarms').kms_master_key_id).toBe('${aws_kms_key.monitoring.arn}')
  })
})

describe('Scenario: A missed report raises an alarm', () => {
  const day = (iso: string) => new Date(iso)

  it('is in alarm at 07:30 UTC on 12 October 2026 when no complete report exists for 2026-10-11', () => {
    const series = emitted(day('2026-10-12T00:00:00Z'), day('2026-10-12T09:00:00Z'), () => '2026-10-10')
    expect(stateAt('2026-10-12T07:30:00Z', series)).toBe('ALARM')
    expect(stateAt('2026-10-12T08:45:00Z', series)).toBe('ALARM')
  })

  it('stays quiet before 07:30 UTC while the run still has time', () => {
    const series = emitted(day('2026-10-12T00:00:00Z'), day('2026-10-12T09:00:00Z'), () => '2026-10-10')
    expect(stateAt('2026-10-12T02:00:00Z', series)).toBe('OK')
    expect(stateAt('2026-10-12T07:29:00Z', series)).toBe('OK')
  })

  it('stays quiet when the report for 2026-10-11 was published complete in time', () => {
    const published = Date.parse('2026-10-12T02:40:00Z')
    const series = emitted(day('2026-10-12T00:00:00Z'), day('2026-10-12T23:59:00Z'), (now) =>
      now.getTime() >= published ? '2026-10-11' : '2026-10-10',
    )
    expect(stateAt('2026-10-12T07:30:00Z', series)).toBe('OK')
    expect(stateAt('2026-10-12T23:59:00Z', series)).toBe('OK')
  })

  it('fires when only an incomplete report exists, since it does not count as complete (AC-5)', () => {
    const series = emitted(day('2026-10-12T00:00:00Z'), day('2026-10-12T09:00:00Z'), () => '2026-10-10')
    expect(stateAt('2026-10-12T07:30:00Z', series)).toBe('ALARM')
  })

  it('fires when no report has ever been completed', () => {
    const series = emitted(day('2026-10-12T00:00:00Z'), day('2026-10-12T09:00:00Z'), () => undefined)
    expect(stateAt('2026-10-12T07:30:00Z', series)).toBe('ALARM')
  })

  it('fires when the worker emits nothing at all, rather than staying silent', () => {
    expect(stateAt('2026-10-12T07:30:00Z', new Map())).toBe('ALARM')
  })

  it('clears once the late report is published', () => {
    const published = Date.parse('2026-10-12T07:50:00Z')
    const series = emitted(day('2026-10-12T00:00:00Z'), day('2026-10-12T09:00:00Z'), (now) =>
      now.getTime() >= published ? '2026-10-11' : '2026-10-10',
    )
    expect(stateAt('2026-10-12T07:45:00Z', series)).toBe('ALARM')
    expect(stateAt('2026-10-12T07:50:00Z', series)).toBe('OK')
  })
})
