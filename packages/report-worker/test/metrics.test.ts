import { describe, expect, it } from 'vitest'
import {
  checkReportDeadline,
  COMPLETE_REPORT_MISSING,
  createEmfMetricsSink,
  generateReport,
  METRIC_NAMESPACE,
  REPORT_COMPLETE,
} from '../src/index.js'
import {
  FakeClock,
  FakeSleeper,
  InMemoryReportStore,
  RecordingMetrics,
  ScriptedGraph,
  signIn,
} from './support/fakes.js'

describe('CloudWatch embedded metric format', () => {
  it('writes one line naming the namespace, the metric and its value', () => {
    const lines: string[] = []
    const clock = new FakeClock('2026-10-12T07:30:00.000Z')
    createEmfMetricsSink((line) => lines.push(line), clock).emit(COMPLETE_REPORT_MISSING, 1, {
      reportDate: '2026-10-11',
    })

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toEqual({
      _aws: {
        Timestamp: clock.now().getTime(),
        CloudWatchMetrics: [
          {
            Namespace: 'SigninReports/ReportWorker',
            Dimensions: [[]],
            Metrics: [{ Name: 'CompleteReportMissing', Unit: 'Count' }],
          },
        ],
      },
      reportDate: '2026-10-11',
      CompleteReportMissing: 1,
    })
    expect(METRIC_NAMESPACE).toBe('SigninReports/ReportWorker')
  })

  it('carries no properties unless given some', () => {
    const lines: string[] = []
    createEmfMetricsSink((line) => lines.push(line), new FakeClock('2026-10-12T02:00:00.000Z')).emit(REPORT_COMPLETE, 0)
    expect(Object.keys(JSON.parse(lines[0] as string)).sort()).toEqual(['ReportComplete', '_aws'])
  })
})

describe('@AC-6 Scenario: A missed report raises an alarm', () => {
  it('reports a missing complete report at 07:30 UTC when nothing was published', async () => {
    const metrics = new RecordingMetrics()
    const clock = new FakeClock('2026-10-12T07:30:00.000Z')
    const result = await checkReportDeadline({ clock, store: new InMemoryReportStore(), metrics })

    expect(result).toEqual({ reportDate: '2026-10-11', missing: true })
    expect(metrics.last(COMPLETE_REPORT_MISSING)).toEqual({
      name: 'CompleteReportMissing',
      value: 1,
      properties: { reportDate: '2026-10-11' },
    })
  })

  it('reports a missing complete report when only an incomplete one was published', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const graph = new ScriptedGraph(clock, { signIns: [signIn()] })
    graph.failWith = (call) => (call.source === 'risk' ? new Error('503') : undefined)
    const store = new InMemoryReportStore()
    const metrics = new RecordingMetrics()
    await generateReport('2026-10-11', {
      clock,
      sleeper: new FakeSleeper(clock),
      signIns: graph,
      risk: graph,
      store,
      metrics,
    })

    clock.set('2026-10-12T07:30:00.000Z')
    expect((await checkReportDeadline({ clock, store, metrics })).missing).toBe(true)
    expect(metrics.last(COMPLETE_REPORT_MISSING)?.value).toBe(1)
  })

  it('clears the alarm when a complete report is published', async () => {
    const clock = new FakeClock('2026-10-12T02:00:00.000Z')
    const graph = new ScriptedGraph(clock, { signIns: [signIn()] })
    const store = new InMemoryReportStore()
    const metrics = new RecordingMetrics()
    await generateReport('2026-10-11', {
      clock,
      sleeper: new FakeSleeper(clock),
      signIns: graph,
      risk: graph,
      store,
      metrics,
    })

    clock.set('2026-10-12T07:30:00.000Z')
    expect((await checkReportDeadline({ clock, store, metrics })).missing).toBe(false)
    expect(metrics.last(COMPLETE_REPORT_MISSING)?.value).toBe(0)
  })
})
