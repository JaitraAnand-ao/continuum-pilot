import { describe, expect, it } from 'vitest'
import {
  contentHash,
  generateReport,
  METRIC_NAMESPACE,
  SIGN_IN_TYPES,
  snapshotHashInput,
  SOURCE_LABELS,
  type SignIn,
} from '../src/index.js'
import { FakeClock, FakeGraph, MemoryStore, RecordingMetrics, riskDetection, signIn } from './support.js'

function deps(graph: FakeGraph, at = '2026-10-12T02:00:00.000Z') {
  return { graph, store: new MemoryStore(), metrics: new RecordingMetrics(), clock: new FakeClock(at) }
}

function oneOfEachType(): SignIn[] {
  return SIGN_IN_TYPES.map((type, index) =>
    signIn({
      id: `s-${type}`,
      signInEventType: type,
      errorCode: index === 0 ? 50126 : 0,
      conditionalAccessPolicies: [{ id: `ca-${type}`, displayName: 'Block legacy auth', result: 'notApplied' }],
      deviceDetail: {
        deviceId: `d-${type}`,
        operatingSystem: 'iOS',
        browser: 'Safari',
        isCompliant: false,
        isManaged: false,
      },
    }),
  )
}

describe('AC-1: one report per UTC day, ready by 08:00 UTC', () => {
  it('the 02:00 UTC run on 12 October publishes exactly one report for 11 October', async () => {
    const d = deps(new FakeGraph(oneOfEachType()))
    const outcome = await generateReport('2026-10-11', d)

    expect(outcome.kind).toBe('published')
    expect([...d.store.reports.keys()]).toEqual(['2026-10-11'])
    const report = d.store.reports.get('2026-10-11')!
    expect(report.windowStart).toBe('2026-10-11T00:00:00.000Z')
    expect(report.windowEnd).toBe('2026-10-12T00:00:00.000Z')
    expect(Date.parse(report.publishedAt)).toBeLessThan(Date.parse('2026-10-12T08:00:00.000Z'))
    expect(report.status).toBe('complete')
  })

  it('fourteen consecutive daily runs leave exactly one published report per previous UTC day', async () => {
    const graph = new FakeGraph(oneOfEachType())
    const store = new MemoryStore()
    const metrics = new RecordingMetrics()
    const clock = new FakeClock('2026-10-01T02:00:00.000Z')
    const expected: string[] = []
    for (let day = 1; day <= 14; day++) {
      const runAt = new Date(Date.UTC(2026, 9, day, 2))
      clock.set(runAt.toISOString())
      const reportDate = new Date(Date.UTC(2026, 9, day - 1)).toISOString().slice(0, 10)
      expected.push(reportDate)
      await generateReport(reportDate, { graph, store, metrics, clock })
    }
    expect([...store.reports.keys()].sort()).toEqual(expected)
    expect(expected[0]).toBe('2026-09-30')
    for (const report of store.reports.values()) expect(report.status).toBe('complete')
  })
})

describe('AC-2: all four sign-in types with CA results and device details', () => {
  it('stores every type, each with its Conditional Access policy results and device details', async () => {
    const d = deps(new FakeGraph(oneOfEachType()))
    await generateReport('2026-10-11', d)
    const snapshot = d.store.reports.get('2026-10-11')!.signIns

    expect(new Set(snapshot.map((s) => s.signInEventType))).toEqual(new Set(SIGN_IN_TYPES))
    for (const stored of snapshot) {
      const type = stored.signInEventType
      expect(stored.conditionalAccessPolicies).toEqual([
        { id: `ca-${type}`, displayName: 'Block legacy auth', result: 'notApplied' },
      ])
      expect(stored.deviceDetail.deviceId).toBe(`d-${type}`)
    }
  })

  it('includes 23:59:59.999 on D and leaves out 00:00:00.000 on D+1 even if Graph returns it', async () => {
    const d = deps(
      new FakeGraph([
        signIn({ id: 'last', createdDateTime: '2026-10-11T23:59:59.999Z' }),
        signIn({ id: 'next', createdDateTime: '2026-10-12T00:00:00.000Z' }),
      ]),
    )
    await generateReport('2026-10-11', d)
    const ids = d.store.reports.get('2026-10-11')!.signIns.map((s) => s.id)
    expect(ids).toContain('last')
    expect(ids).not.toContain('next')
  })

  it('totals reconcile to the stored snapshot', async () => {
    const d = deps(new FakeGraph(oneOfEachType()))
    await generateReport('2026-10-11', d)
    const report = d.store.reports.get('2026-10-11')!
    expect(report.totals).toEqual({ total: 4, successful: 3, failed: 1 })
    expect(report.totals.total).toBe(report.signIns.length)
    expect(report.signIns.filter((s) => s.errorCode === 0)).toHaveLength(report.totals.successful)
  })

  it('stores the Identity Protection risk detections for the window', async () => {
    const d = deps(new FakeGraph([], [riskDetection({ id: 'r1' }), riskDetection({ id: 'r2', riskLevel: 'high' })]))
    await generateReport('2026-10-11', d)
    expect(d.store.reports.get('2026-10-11')!.riskDetections.map((r) => r.id)).toEqual(['r1', 'r2'])
  })
})

describe('AC-3: paging and throttling lose nothing', () => {
  it('collects 184,312 sign-ins across pages, retrying a 429 page after at least 5 seconds', async () => {
    const all: SignIn[] = []
    for (let i = 0; i < 184_312; i++) {
      all.push(
        signIn({
          id: `s${i}`,
          signInEventType: SIGN_IN_TYPES[i % 4]!,
          createdDateTime: new Date(Date.parse('2026-10-11T00:00:00.000Z') + (i % 86_400_000)).toISOString(),
        }),
      )
    }
    const graph = new FakeGraph(all, [], 999)
    graph.signInFailures.set('signIns:servicePrincipal:9990', ['throttle'])
    const d = deps(graph)

    await generateReport('2026-10-11', d)

    const throttledAt = graph.calls.indexOf('signIns:servicePrincipal:9990')
    expect(graph.calls.indexOf('signIns:servicePrincipal:9990', throttledAt + 1)).toBe(throttledAt + 1)
    expect(d.clock.sleeps).toEqual([5000])
    expect(Math.min(...d.clock.sleeps)).toBeGreaterThanOrEqual(5000)
    const report = d.store.reports.get('2026-10-11')!
    expect(report.signIns).toHaveLength(184_312)
    expect(report.totals.total).toBe(184_312)
    expect(report.status).toBe('complete')
  }, 60_000)
})

describe('AC-4: a re-run neither duplicates nor alters a published report', () => {
  it('keeps exactly one report with an unchanged content hash and makes no Graph call', async () => {
    const graph = new FakeGraph(oneOfEachType())
    const d = deps(graph)
    await generateReport('2026-10-11', d)
    const before = structuredClone(d.store.reports.get('2026-10-11')!)
    const callsBefore = graph.calls.length

    d.clock.set('2026-10-12T05:00:00.000Z')
    const again = await generateReport('2026-10-11', d)

    expect(again.kind).toBe('already-published')
    expect(d.store.reports.size).toBe(1)
    expect(d.store.reports.get('2026-10-11')).toEqual(before)
    expect(d.store.reports.get('2026-10-11')!.contentHash).toBe(before.contentHash)
    expect(graph.calls.length).toBe(callsBefore)
  })

  it('returns the stored report when a concurrent run published first', async () => {
    const d = deps(new FakeGraph(oneOfEachType()))
    const first = await generateReport('2026-10-11', d)
    if (first.kind !== 'published') throw new Error('expected published')
    const racing = { ...d, store: Object.assign(Object.create(d.store), { findReport: async () => undefined }) }
    const outcome = await generateReport('2026-10-11', racing)
    expect(outcome).toEqual({ kind: 'already-published', report: first.report })
    expect(d.store.reports.size).toBe(1)
  })

  it('the stored hash is the hash of the stored snapshot and figures', async () => {
    const d = deps(new FakeGraph(oneOfEachType()))
    await generateReport('2026-10-11', d)
    const report = d.store.reports.get('2026-10-11')!
    expect(report.contentHash).toBe(contentHash(snapshotHashInput(report)))
  })
})

describe('AC-5: Graph still failing at 07:00 UTC', () => {
  it('publishes the report marked incomplete, naming Identity Protection risk data as missing', async () => {
    const graph = new FakeGraph(oneOfEachType())
    graph.failRisk = 'always'
    const d = deps(graph)

    const outcome = await generateReport('2026-10-11', d)

    expect(outcome.kind).toBe('published')
    const report = d.store.reports.get('2026-10-11')!
    expect(report.status).toBe('incomplete')
    expect(report.missingSources).toEqual(['identityProtection.riskDetections'])
    expect(report.missingSources.map((s) => SOURCE_LABELS[s])).toEqual(['Identity Protection risk data'])
    expect(report.signIns).toHaveLength(4)
    expect(d.clock.now().getTime()).toBeLessThan(Date.parse('2026-10-12T07:00:00.000Z'))
    expect(Date.parse(report.publishedAt)).toBeLessThan(Date.parse('2026-10-12T08:00:00.000Z'))
    expect(d.metrics.emitted).toContainEqual({
      namespace: METRIC_NAMESPACE,
      name: 'ReportPublished',
      value: 1,
      dimensions: { Status: 'incomplete' },
      timestamp: report.publishedAt,
    })
  })

  it('records the day as not generated when every Graph call fails, and shows no report as complete', async () => {
    const graph = new FakeGraph(oneOfEachType())
    graph.failRisk = 'always'
    graph.failSignIns = 'always'
    const d = deps(graph)

    const outcome = await generateReport('2026-10-11', d)

    expect(outcome.kind).toBe('not-generated')
    expect(d.store.reports.size).toBe(0)
    const day = d.store.notGenerated.get('2026-10-11')!
    expect(day.missingSources).toHaveLength(5)
    expect(Date.parse(day.recordedAt)).toBeLessThan(Date.parse('2026-10-12T07:00:00.000Z'))
    expect(d.metrics.emitted).toContainEqual({
      namespace: METRIC_NAMESPACE,
      name: 'ReportNotGenerated',
      value: 1,
      dimensions: {},
      timestamp: day.recordedAt,
    })
  })

  it('marks the report incomplete naming the sign-in type whose collection failed', async () => {
    const graph = new FakeGraph(oneOfEachType())
    graph.signInFailures.set('signIns:managedIdentity:0', Array<'error'>(100).fill('error'))
    const d = deps(graph)
    await generateReport('2026-10-11', d)
    const report = d.store.reports.get('2026-10-11')!
    expect(report.status).toBe('incomplete')
    expect(report.missingSources).toEqual(['signIns.managedIdentity'])
    expect(report.signIns.map((s) => s.signInEventType)).not.toContain('managedIdentity')
  })

  it('emits ReportPublished with Status complete for a complete report', async () => {
    const d = deps(new FakeGraph(oneOfEachType()))
    await generateReport('2026-10-11', d)
    expect(d.metrics.emitted).toEqual([
      {
        namespace: METRIC_NAMESPACE,
        name: 'ReportPublished',
        value: 1,
        dimensions: { Status: 'complete' },
        timestamp: '2026-10-12T02:00:00.000Z',
      },
    ])
  })
})

describe('AC-7: a day without sign-ins', () => {
  it('still publishes a report whose total, successful and failed counts are 0', async () => {
    const d = deps(new FakeGraph([]))
    const outcome = await generateReport('2026-10-11', d)
    expect(outcome.kind).toBe('published')
    const report = d.store.reports.get('2026-10-11')!
    expect(report.status).toBe('complete')
    expect(report.totals).toEqual({ total: 0, successful: 0, failed: 0 })
    expect(report.signIns).toEqual([])
  })
})

describe('input', () => {
  it('rejects a report date that is not a calendar date', async () => {
    await expect(generateReport('2026-02-30', deps(new FakeGraph()))).rejects.toThrow(/report date/)
  })
})
