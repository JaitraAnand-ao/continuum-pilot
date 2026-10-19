import { describe, expect, it } from 'vitest'
import {
  generateReport,
  METRIC_NAMESPACE,
  REPORT_JOB_GRAPH_PERMISSIONS,
  SIGN_IN_EVENT_TYPES,
  type GraphReader,
} from '../src/index.js'
import { FakeClock, FakeGraph, MemoryMetrics, MemoryStore, signIn } from './support/fakes.js'

function setup(at = '2026-10-12T02:00:00Z') {
  const clock = new FakeClock(at)
  const graph = new FakeGraph(clock)
  const store = new MemoryStore()
  const metrics = new MemoryMetrics()
  const deps = { clock, sleeper: clock, graph, store, metrics }
  return { clock, graph, store, metrics, deps }
}

describe('report.generate', () => {
  it('AC-1: one report for the day, over the exact UTC window, published before 08:00 UTC on D+1', async () => {
    const { graph, store, deps } = setup()
    graph.addSignIns(signIn('s1', '2026-10-11T09:15:00Z', 'interactiveUser'))

    const result = await generateReport('2026-10-11', deps)

    expect(result.status).toBe('published')
    expect([...store.published.keys()]).toEqual(['2026-10-11'])
    const report = store.published.get('2026-10-11')
    expect(report?.window).toEqual({ start: '2026-10-11T00:00:00Z', end: '2026-10-12T00:00:00Z' })
    expect(report?.publishedAt).toBe('2026-10-12T02:00:00.000Z')
    expect(Date.parse(report?.publishedAt ?? '')).toBeLessThan(Date.parse('2026-10-12T08:00:00Z'))
    expect(report?.completeness).toBe('complete')
  })

  it('AC-2: holds all four sign-in types, each with its CA results and device details', async () => {
    const { graph, store, deps } = setup()
    graph.addSignIns(
      signIn('i', '2026-10-11T01:00:00Z', 'interactiveUser'),
      signIn('n', '2026-10-11T02:00:00Z', 'nonInteractiveUser'),
      signIn('s', '2026-10-11T03:00:00Z', 'servicePrincipal'),
      signIn('m', '2026-10-11T04:00:00Z', 'managedIdentity'),
    )

    await generateReport('2026-10-11', deps)

    const stored = store.published.get('2026-10-11')?.snapshot.signIns ?? []
    expect(new Set(stored.map((s) => s.signInEventType))).toEqual(new Set(SIGN_IN_EVENT_TYPES))
    for (const s of stored) {
      expect(s.appliedConditionalAccessPolicies).toEqual([
        { id: 'ca-1', displayName: 'Require MFA', result: 'success' },
      ])
      expect(s.deviceDetail).toMatchObject({ deviceId: `dev-${s.id}` })
    }
    expect(graph.requests.map((r) => r.collection).sort()).toEqual([
      'riskDetections',
      'riskyUsers',
      'signIns/interactiveUser',
      'signIns/managedIdentity',
      'signIns/nonInteractiveUser',
      'signIns/servicePrincipal',
    ])
  })

  it('AC-2: 23:59:59.999 on D is in the snapshot, 00:00:00.000 on D+1 is not', async () => {
    const { graph, store, deps } = setup()
    graph.addSignIns(
      signIn('last', '2026-10-11T23:59:59.999Z', 'interactiveUser'),
      signIn('next', '2026-10-12T00:00:00.000Z', 'interactiveUser'),
    )

    await generateReport('2026-10-11', deps)

    expect(store.published.get('2026-10-11')?.snapshot.signIns.map((s) => s.id)).toEqual(['last'])
    expect(store.published.get('2026-10-11')?.totals.total).toBe(1)
  })

  it('AC-3: 184,312 sign-ins across many pages with one 429 Retry-After 5 s are all collected', async () => {
    const { clock, graph, store, deps } = setup()
    graph.pageSize = 1000
    const day = Date.parse('2026-10-11T00:00:00Z')
    for (let n = 0; n < 184_312; n += 1) {
      const type = SIGN_IN_EVENT_TYPES[n % 4] ?? 'interactiveUser'
      graph.addSignIns(signIn(`s${n}`, new Date(day + (n % 86_400_000)).toISOString(), type, n % 7 === 0 ? 50126 : 0))
    }
    graph.throttle.set('signIns/interactiveUser:17', 5)

    await generateReport('2026-10-11', deps)

    const throttled = graph.requests.filter((r) => r.collection === 'signIns/interactiveUser' && r.index === 17)
    expect(throttled).toHaveLength(2)
    expect(Date.parse(throttled[1]?.at ?? '') - Date.parse(throttled[0]?.at ?? '')).toBeGreaterThanOrEqual(5000)
    expect(clock.sleeps).toContain(5000)
    const report = store.published.get('2026-10-11')
    expect(report?.snapshot.signIns).toHaveLength(184_312)
    expect(report?.totals.total).toBe(184_312)
    expect((report?.totals.successful ?? 0) + (report?.totals.failed ?? 0)).toBe(184_312)
    expect(report?.completeness).toBe('complete')
    /* Generating and cloning 184,312 records outruns the 5 s default on a loaded runner. */
  }, 60_000)

  it('AC-4: a re-run for a published date leaves the report unchanged and creates no second one', async () => {
    const { clock, graph, store, deps } = setup()
    graph.addSignIns(signIn('s1', '2026-10-11T09:15:00Z', 'interactiveUser'))
    await generateReport('2026-10-11', deps)
    const before = structuredClone(store.published.get('2026-10-11'))
    const requestsBefore = graph.requests.length

    graph.addSignIns(signIn('s2', '2026-10-11T10:00:00Z', 'interactiveUser'))
    clock.set('2026-10-12T05:00:00Z')
    const again = await generateReport('2026-10-11', deps)

    expect(again.status).toBe('already-published')
    expect(store.published.size).toBe(1)
    expect(store.published.get('2026-10-11')).toEqual(before)
    expect(store.published.get('2026-10-11')?.contentHash).toBe(before?.contentHash)
    expect(graph.requests.length).toBe(requestsBefore)
    expect(store.publishCalls).toBe(1)
  })

  it('AC-4: a concurrent publish that loses the race returns the stored report, not its own', async () => {
    const { graph, store, deps } = setup()
    graph.addSignIns(signIn('s1', '2026-10-11T09:15:00Z', 'interactiveUser'))
    const first = generateReport('2026-10-11', deps)
    const second = generateReport('2026-10-11', deps)
    const results = await Promise.all([first, second])

    expect(store.published.size).toBe(1)
    expect(results.map((r) => r.status).sort()).toEqual(['already-published', 'published'])
    const hashes = results.map((r) => (r.status === 'not-generated' ? '' : r.report.contentHash))
    expect(hashes[0]).toBe(hashes[1])
  })

  it('AC-5: Identity Protection failing until 07:00 UTC publishes incomplete, naming it', async () => {
    const { clock, graph, store, metrics, deps } = setup()
    graph.addSignIns(signIn('s1', '2026-10-11T09:15:00Z', 'interactiveUser'))
    graph.fail = (collection) => collection === 'riskDetections' || collection === 'riskyUsers'

    const result = await generateReport('2026-10-11', deps)

    expect(result.status).toBe('published')
    const report = store.published.get('2026-10-11')
    expect(report?.completeness).toBe('incomplete')
    expect(report?.missingSources).toEqual(['identityProtection'])
    expect(report?.missingSourceLabels).toEqual(['Identity Protection risk data'])
    expect(report?.totals.total).toBe(1)
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(Date.parse('2026-10-12T07:00:00Z'))
    expect(Date.parse(report?.publishedAt ?? '')).toBeGreaterThanOrEqual(Date.parse('2026-10-12T07:00:00Z'))
    expect(metrics.named('ReportIncomplete')).toEqual([
      { namespace: METRIC_NAMESPACE, name: 'ReportIncomplete', value: 1, unit: 'Count' },
    ])
    expect(metrics.named('ReportPublished')).toEqual([
      { namespace: METRIC_NAMESPACE, name: 'ReportPublished', value: 1, unit: 'Count' },
    ])
  })

  it('AC-5: every Graph call failing until 07:00 UTC records the day as not generated, never complete', async () => {
    const { graph, store, metrics, deps } = setup()
    graph.addSignIns(signIn('s1', '2026-10-11T09:15:00Z', 'interactiveUser'))
    graph.fail = () => true
    graph.throwOn = (collection) => collection === 'riskyUsers'

    const result = await generateReport('2026-10-11', deps)

    expect(result.status).toBe('not-generated')
    expect(store.published.has('2026-10-11')).toBe(false)
    expect(store.notGenerated.get('2026-10-11')).toEqual({
      reportDate: '2026-10-11',
      status: 'not-generated',
      missingSources: [...SIGN_IN_EVENT_TYPES, 'identityProtection'],
      missingSourceLabels: [
        'Interactive user sign-ins',
        'Non-interactive user sign-ins',
        'Service principal sign-ins',
        'Managed identity sign-ins',
        'Identity Protection risk data',
      ],
      recordedAt: expect.stringMatching(/^2026-10-12T07:0/),
    })
    expect(metrics.named('ReportNotGenerated')).toEqual([
      { namespace: METRIC_NAMESPACE, name: 'ReportNotGenerated', value: 1, unit: 'Count' },
    ])
    expect(metrics.named('ReportPublished')).toEqual([])
  })

  it('AC-5: a day recorded as not generated can still be published by a later run', async () => {
    const { clock, graph, store, deps } = setup()
    graph.fail = () => true
    await generateReport('2026-10-11', deps)
    graph.fail = () => false
    clock.set('2026-10-12T09:00:00Z')

    const result = await generateReport('2026-10-11', deps)

    expect(result.status).toBe('published')
    expect(store.notGenerated.has('2026-10-11')).toBe(false)
  })

  it('AC-7: a day with no sign-ins still publishes a report whose totals are zero', async () => {
    const { store, metrics, deps } = setup()

    const result = await generateReport('2026-10-11', deps)

    expect(result.status).toBe('published')
    const report = store.published.get('2026-10-11')
    expect(report?.completeness).toBe('complete')
    expect([report?.totals.total, report?.totals.successful, report?.totals.failed]).toEqual([0, 0, 0])
    expect(metrics.named('ReportIncomplete')).toEqual([
      { namespace: METRIC_NAMESPACE, name: 'ReportIncomplete', value: 0, unit: 'Count' },
    ])
  })

  it('AC-8: the job reads only, through a port that offers no write, under the four read permissions', async () => {
    const { graph, deps } = setup()
    const called: string[] = []
    const recording = new Proxy(graph, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value === 'function' && String(property).startsWith('read')) {
          return (...args: unknown[]) => {
            called.push(String(property))
            return value.apply(target, args)
          }
        }
        return value
      },
    }) as GraphReader

    await generateReport('2026-10-11', { ...deps, graph: recording })

    expect(new Set(called)).toEqual(new Set(['readSignInPage', 'readRiskDetectionPage', 'readRiskyUserPage']))
    expect([...REPORT_JOB_GRAPH_PERMISSIONS].sort()).toEqual([
      'AuditLog.Read.All',
      'IdentityRiskEvent.Read.All',
      'IdentityRiskyUser.Read.All',
      'Policy.Read.All',
    ])
    expect(REPORT_JOB_GRAPH_PERMISSIONS.every((p) => p.includes('.Read.'))).toBe(true)
  })

  it('rejects a payload date that is not a calendar day before touching Graph or the store', async () => {
    const { graph, store, deps } = setup()
    await expect(generateReport('2026-02-30', deps)).rejects.toThrow(RangeError)
    expect(graph.requests).toEqual([])
    expect(store.publishCalls).toBe(0)
  })
})
