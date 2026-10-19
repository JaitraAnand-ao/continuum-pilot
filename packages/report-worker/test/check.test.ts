import { describe, expect, it } from 'vitest'
import { checkCompleteReport, generateReport, METRIC_NAMESPACE } from '../src/index.js'
import { FakeClock, FakeGraph, MemoryStore, RecordingMetrics, signIn } from './support.js'

/* AC-6: the 07:30 UTC check emits CompleteReportMissing; the CloudWatch alarm (CMP-11) fires on value 1. */
describe('AC-6: no complete report by 07:30 UTC', () => {
  const at0730 = '2026-10-12T07:30:00.000Z'

  it('emits CompleteReportMissing = 1 when no report exists for D', async () => {
    const metrics = new RecordingMetrics()
    const missing = await checkCompleteReport('2026-10-11', {
      store: new MemoryStore(),
      metrics,
      clock: new FakeClock(at0730),
    })
    expect(missing).toBe(true)
    expect(metrics.emitted).toEqual([
      { namespace: METRIC_NAMESPACE, name: 'CompleteReportMissing', value: 1, dimensions: {}, timestamp: at0730 },
    ])
  })

  it('emits 1 when only an incomplete report exists', async () => {
    const graph = new FakeGraph([signIn({ id: 'a' })])
    graph.failRisk = 'always'
    const store = new MemoryStore()
    await generateReport('2026-10-11', {
      graph,
      store,
      metrics: new RecordingMetrics(),
      clock: new FakeClock('2026-10-12T02:00:00.000Z'),
    })
    const metrics = new RecordingMetrics()
    expect(await checkCompleteReport('2026-10-11', { store, metrics, clock: new FakeClock(at0730) })).toBe(true)
    expect(metrics.emitted[0]!.value).toBe(1)
  })

  it('emits 0 when a complete report exists', async () => {
    const store = new MemoryStore()
    await generateReport('2026-10-11', {
      graph: new FakeGraph([]),
      store,
      metrics: new RecordingMetrics(),
      clock: new FakeClock('2026-10-12T02:00:00.000Z'),
    })
    const metrics = new RecordingMetrics()
    expect(await checkCompleteReport('2026-10-11', { store, metrics, clock: new FakeClock(at0730) })).toBe(false)
    expect(metrics.emitted).toEqual([
      { namespace: METRIC_NAMESPACE, name: 'CompleteReportMissing', value: 0, dimensions: {}, timestamp: at0730 },
    ])
  })
})
