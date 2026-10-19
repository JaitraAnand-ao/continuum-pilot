import { describe, expect, it } from 'vitest'
import { loadMetricContract, loadModule, resource } from './terraform'

const module = loadModule()
const contract = loadMetricContract()

const DAY = 24 * 60 * 60
const CHECK_AT = (7 * 60 + 30) * 60

/* A missing-data alarm goes into alarm once its whole window holds no datapoint. When yesterday's 07:30 UTC
   check emitted and today's never does, that is the end of the first period starting one window after the
   period holding yesterday's datapoint: the worst case, in seconds after today's 00:00 UTC. */
function worstCaseDetection(alarm: Record<string, unknown>): number {
  const period = alarm['period'] as number
  const window = period * (alarm['evaluation_periods'] as number)
  const yesterdaysPeriodStart = Math.floor(CHECK_AT / period) * period - DAY
  return yesterdaysPeriodStart + period + window
}

describe('Feature: Have yesterday’s sign-ins collected from Microsoft Graph and a report published by 08:00 UTC', () => {
  describe('@AC-6 Scenario: A missed report raises an alarm', () => {
    const alarm = resource(module, 'aws_cloudwatch_metric_alarm', 'no_report_by_0730_utc')
    const metric = contract.metrics.find((m) => m.name === alarm['metric_name'])

    it("is named the 'no report by 07:30 UTC' alarm", () => {
      expect(alarm['alarm_name']).toBe('${var.name_prefix}-no-report-by-0730-utc')
      expect(alarm['alarm_description']).toMatch(/no complete report.*07:30 UTC/i)
    })

    it('watches the exact namespace and metric the report worker emits', () => {
      expect(alarm['namespace']).toBe(contract.namespace)
      expect(contract.namespace).toBe('SigninReports/ReportWorker')
      expect(metric).toBeDefined()
      expect(metric?.name).toBe('CompleteReportAvailable')
      expect(alarm['statistic']).toBe(metric?.statistic)
      expect(alarm).not.toHaveProperty('dimensions')
    })

    it('reads a metric the worker emits at 07:30 UTC for the previous UTC day', () => {
      expect(metric?.emittedBy).toBe('report-worker job report.deadline-check')
      expect(metric?.scheduleCron).toBe('30 7 * * *')
      expect(metric?.timezone).toBe('UTC')
      expect(metric?.values['0']).toMatch(/no complete report/i)
      expect(metric?.values['0']).toMatch(/incomplete|not generated/i)
      expect(metric?.values['1']).toMatch(/complete report/i)
    })

    it('goes into alarm when the 07:30 UTC check reports no complete report', () => {
      expect(alarm['comparison_operator']).toBe('LessThanThreshold')
      expect(alarm['threshold']).toBe(1)
      expect(alarm['statistic']).toBe('Minimum')
      expect(alarm['evaluation_periods']).toBe(1)
      expect(alarm['datapoints_to_alarm']).toBe(1)
    })

    it('fires within five minutes of 07:30 UTC, before the 08:00 UTC publication deadline', () => {
      expect(alarm['period']).toBeLessThanOrEqual(300)
      expect((alarm['period'] as number) * (alarm['evaluation_periods'] as number)).toBeLessThan(30 * 60)
    })

    it('does not fire on the hours of the day when no check runs', () => {
      expect(alarm['treat_missing_data']).toBe('notBreaching')
    })

    it('notifies the encrypted alarm topic on alarm and on recovery', () => {
      expect(alarm['alarm_actions']).toEqual(['${aws_sns_topic.alarms.arn}'])
      expect(alarm['ok_actions']).toEqual(['${aws_sns_topic.alarms.arn}'])
      expect(resource(module, 'aws_sns_topic', 'alarms')['kms_master_key_id']).toBe('${aws_kms_key.monitoring.arn}')
    })
  })

  describe('@AC-6 Scenario: A missed report raises an alarm — even when the 07:30 UTC check itself never runs', () => {
    const alarm = resource(module, 'aws_cloudwatch_metric_alarm', 'report_deadline_check_missing')

    it('watches the same emitted metric for the absence of any datapoint for a whole day', () => {
      expect(alarm['namespace']).toBe(contract.namespace)
      expect(alarm['metric_name']).toBe('CompleteReportAvailable')
      expect(alarm['statistic']).toBe('SampleCount')
      expect(alarm['comparison_operator']).toBe('LessThanThreshold')
      expect(alarm['threshold']).toBe(1)
      expect((alarm['period'] as number) * (alarm['evaluation_periods'] as number)).toBe(24 * 60 * 60)
      expect(alarm['datapoints_to_alarm']).toBe(alarm['evaluation_periods'])
      expect(alarm['treat_missing_data']).toBe('breaching')
      expect(alarm['alarm_actions']).toEqual(['${aws_sns_topic.alarms.arn}'])
    })

    it('fires by 07:35 UTC on the day the 07:30 UTC check does not run, before the 08:00 UTC deadline', () => {
      const detectedAt = worstCaseDetection(alarm)
      expect(detectedAt).toBeGreaterThan(CHECK_AT)
      expect(detectedAt).toBeLessThanOrEqual(CHECK_AT + 5 * 60)
      expect(detectedAt).toBeLessThan(8 * 60 * 60)
      expect(alarm['alarm_description']).toMatch(/07:35 UTC/)
    })
  })
})
