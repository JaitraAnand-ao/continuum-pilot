import { describe, expect, it } from 'vitest'
import { contentHash, figuresOf, generateReport, snapshotHashInput } from '../src/index.js'
import { FakeClock, FakeGraph, MemoryStore, RecordingMetrics, signIn } from './support.js'

function day() {
  return [
    signIn({ id: 'first', createdDateTime: '2026-10-11T00:00:00.000Z', errorCode: 50126 }),
    signIn({ id: 'last', createdDateTime: '2026-10-11T23:59:59.999Z', appId: 'app-wd', appDisplayName: 'Workday' }),
    signIn({ id: 'next-day', createdDateTime: '2026-10-12T00:00:00.000Z', errorCode: 53003 }),
    signIn({ id: 'day-before', createdDateTime: '2026-10-10T23:59:59.999Z', errorCode: 50053 }),
    signIn({ id: 'sp', signInEventType: 'servicePrincipal', errorCode: 7000215 }),
  ]
}

async function publish(graph: FakeGraph, store = new MemoryStore()) {
  const outcome = await generateReport('2026-10-11', {
    graph,
    store,
    metrics: new RecordingMetrics(),
    clock: new FakeClock('2026-10-12T02:00:00.000Z'),
  })
  return { outcome, store }
}

describe('the Daily report figures are computed once, from the snapshot, at publish (AC-1, AC-10)', () => {
  it('stores figures derived from exactly the sign-ins in the 00:00–24:00 UTC window', async () => {
    const { outcome, store } = await publish(new FakeGraph(day()))
    if (outcome.kind !== 'published') throw new Error(`expected published, got ${outcome.kind}`)
    const report = store.reports.get('2026-10-11')!

    expect(report.figures).toEqual(figuresOf(report.signIns))
    expect(report.signIns.map((s) => s.id).sort()).toEqual(['first', 'last', 'sp'])
    expect(report.figures.all.totals).toEqual({ total: 3, successful: 1, failed: 2 })
    expect(report.figures.all.totals).toEqual(report.totals)
    expect(report.figures.all.errorCodes).toEqual([
      { errorCode: 50126, failed: 1 },
      { errorCode: 7000215, failed: 1 },
    ])
    expect(report.figures.servicePrincipal.totals).toEqual({ total: 1, successful: 0, failed: 1 })
    expect(report.figures.managedIdentity.totals.total).toBe(0)
  })

  it('the content hash covers the figures, so a changed figure no longer matches the stored hash', async () => {
    const { store } = await publish(new FakeGraph(day()))
    const report = store.reports.get('2026-10-11')!
    expect(contentHash(snapshotHashInput(report))).toBe(report.contentHash)

    const altered = structuredClone(report)
    altered.figures.all.applications[0]!.failed += 1
    expect(contentHash(snapshotHashInput(altered))).not.toBe(report.contentHash)
  })

  it('late sign-ins arriving in Entra after publication leave every figure as it was published', async () => {
    const graph = new FakeGraph(day())
    const { outcome, store } = await publish(graph)
    if (outcome.kind !== 'published') throw new Error(`expected published, got ${outcome.kind}`)
    const published = structuredClone(outcome.report)
    expect(published.figures.all.totals).toEqual({ total: 3, successful: 1, failed: 2 })

    const late = new FakeGraph([...day(), signIn({ id: 'late', createdDateTime: '2026-10-11T18:00:00.000Z' })])
    const again = await publish(late, store)

    expect(again.outcome.kind).toBe('already-published')
    if (again.outcome.kind !== 'already-published') return
    expect(again.outcome.report.figures).toEqual(published.figures)
    expect(again.outcome.report.contentHash).toBe(published.contentHash)
    expect(late.calls).toEqual([])
  })
})
