import { describe, expect, it } from 'vitest'
import {
  checkCompleteReport,
  generateReport,
  METRIC_NAMESPACE,
  QUEUE_CHECK,
  startReportWorker,
  type Metric,
  type ReportWorkerBoss,
} from '../../../packages/report-worker/src/index.js'
import { FakeClock, FakeGraph, MemoryStore, RecordingMetrics } from '../../../packages/report-worker/test/support.js'
import { evaluateAlarm, loadModule, resources, type Datapoint, type Json } from './lib/module.js'

const mod = loadModule()
const alarms = resources(mod, 'aws_cloudwatch_metric_alarm')
const TOPIC = '${aws_sns_topic.alarms.arn}'

function datapointsOf(emitted: readonly Metric[], name: Metric['name']): Datapoint[] {
  return emitted.filter((m) => m.name === name).map((m) => ({ timestamp: m.timestamp, value: m.value }))
}

/* The metrics report-worker really emits, captured by running it once per outcome. */
async function emittedMetrics(): Promise<Metric[]> {
  const metrics = new RecordingMetrics()
  const store = new MemoryStore()
  await generateReport('2026-10-10', {
    graph: new FakeGraph([]),
    store,
    metrics,
    clock: new FakeClock('2026-10-11T02:00:00.000Z'),
  })
  const failing = new FakeGraph([])
  failing.failSignIns = 'always'
  failing.failRisk = 'always'
  await generateReport('2026-10-11', {
    graph: failing,
    store,
    metrics,
    clock: new FakeClock('2026-10-12T02:00:00.000Z'),
  })
  await checkCompleteReport('2026-10-11', { store, metrics, clock: new FakeClock('2026-10-12T07:30:00.000Z') })
  return metrics.emitted
}

describe('every alarm watches a metric report-worker emits', () => {
  it('names the exact namespace, metric name and dimensions the worker puts', async () => {
    const emitted = await emittedMetrics()
    expect(Object.keys(alarms).length).toBeGreaterThanOrEqual(3)
    for (const [name, alarm] of Object.entries(alarms)) {
      expect(alarm.namespace, name).toBe(METRIC_NAMESPACE)
      const matching = emitted.filter((m) => m.name === alarm.metric_name)
      expect(matching.length, `${name} watches ${String(alarm.metric_name)}`).toBeGreaterThan(0)
      /* CloudWatch matches a metric by its full dimension set; the worker puts these without dimensions. */
      for (const m of matching) expect(m.dimensions).toEqual({})
      expect(alarm.dimensions, name).toBeUndefined()
    }
  })

  it('notifies the KMS-encrypted alarm topic on ALARM and on OK', () => {
    for (const [name, alarm] of Object.entries(alarms)) {
      expect(alarm.alarm_actions, name).toEqual([TOPIC])
      expect(alarm.ok_actions, name).toEqual([TOPIC])
      expect(alarm.actions_enabled, name).toBe(true)
    }
    expect(resources(mod, 'aws_sns_topic').alarms!.kms_master_key_id).toBe('${aws_kms_key.logs.arn}')
  })
})

describe("AC-6: the 'no report by 07:30 UTC' alarm", () => {
  const alarm = alarms.no_report_by_0730 as Json

  it('is named for the story and watches CompleteReportMissing >= 1', () => {
    expect(alarm.alarm_name).toBe('${var.name_prefix}-no-report-by-0730-utc')
    expect(String(alarm.alarm_description)).toContain('no report by 07:30 UTC')
    expect(alarm.metric_name).toBe('CompleteReportMissing')
    expect(alarm.statistic).toBe('Maximum')
    expect(alarm.comparison_operator).toBe('GreaterThanOrEqualToThreshold')
    expect(alarm.threshold).toBe(1)
    expect(alarm.evaluation_periods).toBe(1)
  })

  it('is fed by the check report-worker schedules at 07:30 UTC every day', async () => {
    const schedules: { name: string; cron: string; tz: string }[] = []
    const boss: ReportWorkerBoss = {
      createQueue: async () => {},
      schedule: async (name, cron, _data, options) => {
        schedules.push({ name, cron, tz: options.tz })
      },
      work: async () => 'worker',
    }
    await startReportWorker(boss, {
      graph: new FakeGraph([]),
      store: new MemoryStore(),
      metrics: new RecordingMetrics(),
      clock: new FakeClock('2026-10-12T00:00:00.000Z'),
    })
    expect(schedules).toContainEqual({ name: QUEUE_CHECK, cron: '30 7 * * *', tz: 'UTC' })
    expect(String(alarm.alarm_description)).toContain(QUEUE_CHECK)
  })

  it('is in alarm state at 07:30 UTC on 12 October when no complete report exists for 2026-10-11', async () => {
    const metrics = new RecordingMetrics()
    await checkCompleteReport('2026-10-11', {
      store: new MemoryStore(),
      metrics,
      clock: new FakeClock('2026-10-12T07:30:00.000Z'),
    })
    const points = datapointsOf(metrics.emitted, 'CompleteReportMissing')
    expect(evaluateAlarm(alarm, points, '2026-10-12T07:31:00.000Z')).toBe('ALARM')
    /* It is still in alarm when the 08:00 publication deadline passes. */
    expect(evaluateAlarm(alarm, points, '2026-10-12T08:00:00.000Z')).toBe('ALARM')
  })

  it('stays OK when the complete report for 2026-10-11 was published', async () => {
    const store = new MemoryStore()
    await generateReport('2026-10-11', {
      graph: new FakeGraph([]),
      store,
      metrics: new RecordingMetrics(),
      clock: new FakeClock('2026-10-12T02:00:00.000Z'),
    })
    const metrics = new RecordingMetrics()
    await checkCompleteReport('2026-10-11', { store, metrics, clock: new FakeClock('2026-10-12T07:30:00.000Z') })
    const points = datapointsOf(metrics.emitted, 'CompleteReportMissing')
    expect(evaluateAlarm(alarm, points, '2026-10-12T07:31:00.000Z')).toBe('OK')
  })

  it('does not flap between daily checks: no datapoint is not a breach', () => {
    expect(alarm.treat_missing_data).toBe('notBreaching')
    expect(evaluateAlarm(alarm, [], '2026-10-12T15:00:00.000Z')).toBe('OK')
  })
})

describe('AC-6: the check itself going silent raises an alarm', () => {
  const alarm = alarms.report_check_silent as Json
  const daily = (days: number): Datapoint[] =>
    Array.from({ length: days }, (_, i) => ({
      timestamp: new Date(Date.parse('2026-10-01T07:30:00.000Z') + i * 86_400_000).toISOString(),
      value: 0,
    }))

  it('counts CompleteReportMissing datapoints and treats their absence as breaching', () => {
    expect(alarm.metric_name).toBe('CompleteReportMissing')
    expect(alarm.statistic).toBe('SampleCount')
    expect(alarm.comparison_operator).toBe('LessThanThreshold')
    expect(alarm.threshold).toBe(1)
    expect(alarm.treat_missing_data).toBe('breaching')
  })

  it('looks back just over one day, so one daily check keeps it OK at every hour', () => {
    const lookback = Number(alarm.period) * Number(alarm.evaluation_periods)
    expect(lookback).toBeGreaterThan(86_400)
    expect(lookback).toBeLessThanOrEqual(90_000)
    expect(alarm.datapoints_to_alarm).toBe(alarm.evaluation_periods)
    const points = daily(10)
    for (let h = 0; h < 24; h++) {
      const at = new Date(Date.parse('2026-10-08T00:00:00.000Z') + h * 3_600_000).toISOString()
      expect(evaluateAlarm(alarm, points, at), at).toBe('OK')
    }
  })

  it('fires when the 07:30 check did not run, so a dead worker cannot hide a missing report', () => {
    /* Last check on 11 October 07:30; none on 12 October. */
    const points = daily(11)
    expect(evaluateAlarm(alarm, points, '2026-10-12T08:31:00.000Z')).toBe('ALARM')
  })
})

describe('AC-5: a day recorded as not generated raises an alarm', () => {
  const alarm = alarms.report_not_generated as Json

  it('watches ReportNotGenerated >= 1', () => {
    expect(alarm.metric_name).toBe('ReportNotGenerated')
    expect(alarm.statistic).toBe('Sum')
    expect(alarm.comparison_operator).toBe('GreaterThanOrEqualToThreshold')
    expect(alarm.threshold).toBe(1)
    expect(alarm.treat_missing_data).toBe('notBreaching')
  })

  it('is in alarm state when every Graph call fails until the 07:00 UTC retry deadline', async () => {
    const graph = new FakeGraph([])
    graph.failSignIns = 'always'
    graph.failRisk = 'always'
    const metrics = new RecordingMetrics()
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const outcome = await generateReport('2026-10-11', { graph, store: new MemoryStore(), metrics, clock })
    expect(outcome.kind).toBe('not-generated')
    const points = datapointsOf(metrics.emitted, 'ReportNotGenerated')
    expect(evaluateAlarm(alarm, points, clock.now().toISOString())).toBe('ALARM')
  })
})
