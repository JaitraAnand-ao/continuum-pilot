import { describe, expect, it } from 'vitest'
import {
  checkCompleteReport,
  COMPLETE_REPORT_MISSING_METRIC,
  emfMetricsSink,
  generateReport,
  METRIC_NAMESPACE,
} from '../src/index.js'
import { FakeClock, FakeGraph, MemoryMetrics, MemoryStore, signIn } from './support/fakes.js'

function setup(at: string) {
  const clock = new FakeClock(at)
  const graph = new FakeGraph(clock)
  const store = new MemoryStore()
  const metrics = new MemoryMetrics()
  return { clock, graph, store, metrics, deps: { clock, sleeper: clock, graph, store, metrics } }
}

const missing = (value: number) => ({
  namespace: METRIC_NAMESPACE,
  name: COMPLETE_REPORT_MISSING_METRIC,
  value,
  unit: 'Count',
})

describe('the 07:30 UTC complete-report check (AC-6)', () => {
  it('emits CompleteReportMissing = 1 when no report exists for D at 07:30 UTC on D+1', async () => {
    const { store, metrics, clock } = setup('2026-10-12T07:30:00Z')

    const result = await checkCompleteReport({ clock, store, metrics })

    expect(result).toEqual({ status: 'checked', reportDate: '2026-10-11', completeReportMissing: true })
    expect(metrics.data).toEqual([missing(1)])
    expect(METRIC_NAMESPACE).toBe('SigninReports')
    expect(COMPLETE_REPORT_MISSING_METRIC).toBe('CompleteReportMissing')
  })

  it('emits 1 when the only report for D is incomplete', async () => {
    const { graph, store, metrics, clock, deps } = setup('2026-10-12T02:00:00Z')
    graph.fail = (collection) => collection === 'riskDetections'
    await generateReport('2026-10-11', deps)
    clock.set('2026-10-12T07:30:00Z')
    metrics.data.length = 0

    await checkCompleteReport({ clock, store, metrics })

    expect(metrics.data).toEqual([missing(1)])
  })

  it('emits 1 when the day was recorded as not generated', async () => {
    const { graph, store, metrics, clock, deps } = setup('2026-10-12T02:00:00Z')
    graph.fail = () => true
    await generateReport('2026-10-11', deps)
    clock.set('2026-10-12T07:30:00Z')
    metrics.data.length = 0

    await checkCompleteReport({ clock, store, metrics })

    expect(metrics.data).toEqual([missing(1)])
  })

  it('emits 0 when a complete report for D is stored', async () => {
    const { graph, store, metrics, clock, deps } = setup('2026-10-12T02:00:00Z')
    graph.addSignIns(signIn('s1', '2026-10-11T09:15:00Z', 'interactiveUser'))
    await generateReport('2026-10-11', deps)
    clock.set('2026-10-12T07:30:00Z')
    metrics.data.length = 0

    const result = await checkCompleteReport({ clock, store, metrics })

    expect(result).toEqual({ status: 'checked', reportDate: '2026-10-11', completeReportMissing: false })
    expect(metrics.data).toEqual([missing(0)])
  })

  it('emits nothing before 07:30 UTC, one millisecond early included', async () => {
    const { store, metrics, clock } = setup('2026-10-12T07:29:59.999Z')

    const result = await checkCompleteReport({ clock, store, metrics })

    expect(result).toEqual({ status: 'too-early', reportDate: '2026-10-11' })
    expect(metrics.data).toEqual([])
  })
})

describe('emfMetricsSink', () => {
  it('writes one CloudWatch Embedded Metric Format line per datum, timestamped by the clock', async () => {
    const lines: string[] = []
    const clock = new FakeClock('2026-10-12T07:30:00Z')
    const sink = emfMetricsSink({ clock, write: (line) => lines.push(line) })

    await sink.put({ namespace: 'SigninReports', name: 'CompleteReportMissing', value: 1, unit: 'Count' })

    expect(lines).toHaveLength(1)
    expect(lines[0]?.endsWith('\n')).toBe(true)
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      _aws: {
        Timestamp: Date.parse('2026-10-12T07:30:00Z'),
        CloudWatchMetrics: [
          {
            Namespace: 'SigninReports',
            Dimensions: [[]],
            Metrics: [{ Name: 'CompleteReportMissing', Unit: 'Count' }],
          },
        ],
      },
      CompleteReportMissing: 1,
    })
  })
})
