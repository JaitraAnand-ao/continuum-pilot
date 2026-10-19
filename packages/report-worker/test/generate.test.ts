import { describe, expect, it } from 'vitest'
import {
  GRAPH_PERMISSIONS,
  IDENTITY_PROTECTION_SOURCE,
  METRIC_NAMESPACE,
  METRICS,
  SIGN_IN_SOURCE,
  createInMemoryReportStore,
  generateReport,
  type GenerateDeps,
  type RiskDetection,
  type SignIn,
} from '../src/index.js'
import { FakeClock, FakeRiskSource, FakeSignInSource, RecordingMetrics, manySignIns, signIn } from './fakes.js'

const risk: RiskDetection = {
  id: 'rd-1',
  activityDateTime: '2026-10-11T10:00:00.000Z',
  riskEventType: 'unfamiliarFeatures',
  riskLevel: 'medium',
  userId: 'u-1',
}

function setUp(signIns: SignIn[], options: { signIns?: object; risk?: object; now?: string } = {}) {
  const clock = new FakeClock(options.now ?? '2026-10-12T02:00:00Z')
  const signInSource = new FakeSignInSource(signIns, { clock, ...options.signIns })
  const riskSource = new FakeRiskSource([risk], { clock, ...options.risk })
  const store = createInMemoryReportStore()
  const metrics = new RecordingMetrics()
  const deps: GenerateDeps = { clock, sleeper: clock, signIns: signInSource, risk: riskSource, store, metrics }
  return { clock, signInSource, riskSource, store, metrics, deps }
}

describe('generateReport', () => {
  it('AC-1: publishes exactly one report for D with the exact window, before 08:00 UTC on D+1', async () => {
    const { deps, store } = setUp([signIn('2026-10-11T09:00:00.000Z'), signIn('2026-10-11T13:00:00.000Z')])
    const outcome = await generateReport(deps, '2026-10-11')
    expect(outcome.outcome).toBe('published')
    const reports = (await store.list()).filter((report) => report.reportDate === '2026-10-11')
    expect(reports).toHaveLength(1)
    expect(reports[0]!.windowStart).toBe('2026-10-11T00:00:00.000Z')
    expect(reports[0]!.windowEnd).toBe('2026-10-12T00:00:00.000Z')
    expect(Date.parse(reports[0]!.publishedAt)).toBeLessThan(Date.parse('2026-10-12T08:00:00.000Z'))
    expect(reports[0]!.complete).toBe(true)
    expect(reports[0]!.missingSources).toEqual([])
  })

  it('AC-2: stores all four sign-in types, each with its CA policy results and device details', async () => {
    const types = ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity'] as const
    const input = types.map((type, i) => signIn(`2026-10-11T0${i}:00:00.000Z`, { signInEventType: type }))
    const { deps } = setUp(input)
    const outcome = await generateReport(deps, '2026-10-11')
    if (outcome.outcome !== 'published') throw new Error(outcome.outcome)
    const stored = outcome.report.signIns
    expect(new Set(stored.map((s) => s.signInEventType))).toEqual(new Set(types))
    for (const s of stored) {
      expect(s.appliedConditionalAccessPolicies).toEqual([
        { id: 'ca-1', displayName: 'Require MFA', result: 'success' },
      ])
      expect(s.deviceDetail.deviceId).toBe('dev-1')
    }
    expect(outcome.report.totals.byType).toEqual({
      interactiveUser: 1,
      nonInteractiveUser: 1,
      servicePrincipal: 1,
      managedIdentity: 1,
    })
  })

  it('AC-2: the 23:59:59.999 sign-in is in the snapshot and the 00:00:00.000 next-day one is not', async () => {
    const last = signIn('2026-10-11T23:59:59.999Z')
    const next = signIn('2026-10-12T00:00:00.000Z')
    const { deps } = setUp([last, next])
    const outcome = await generateReport(deps, '2026-10-11')
    if (outcome.outcome !== 'published') throw new Error(outcome.outcome)
    const ids = outcome.report.signIns.map((s) => s.id)
    expect(ids).toContain(last.id)
    expect(ids).not.toContain(next.id)
  })

  it('AC-2: drops anything a source returns outside the window rather than trust it', async () => {
    const inside = signIn('2026-10-11T12:00:00.000Z')
    const outside = signIn('2026-10-12T00:00:00.000Z')
    const { deps } = setUp([])
    deps.signIns = {
      fetchSignInsPage: async () => ({ kind: 'page', items: [inside, outside], next: null }),
    }
    const outcome = await generateReport(deps, '2026-10-11')
    if (outcome.outcome !== 'published') throw new Error(outcome.outcome)
    expect(outcome.report.signIns.map((s) => s.id)).toEqual([inside.id])
    expect(outcome.report.totals.total).toBe(1)
  })

  it('AC-3: collects 184,312 sign-ins across many pages despite a 429 with Retry-After 5', async () => {
    const all = manySignIns(184_312, '2026-10-11')
    const { deps, signInSource } = setUp(all, {
      signIns: { pageSize: 999, throttle: { atCursor: '99900', retryAfterSeconds: 5 } },
    })
    const outcome = await generateReport(deps, '2026-10-11')
    if (outcome.outcome !== 'published') throw new Error(outcome.outcome)
    expect(outcome.report.signIns).toHaveLength(184_312)
    expect(outcome.report.totals.total).toBe(184_312)
    const [throttled, retried] = signInSource.calls.filter((call) => call.cursor === '99900')
    expect(retried!.at - throttled!.at).toBeGreaterThanOrEqual(5000)
    // Figures reconcile to the snapshot.
    const failed = outcome.report.signIns.filter((s) => s.status.errorCode !== 0).length
    expect(outcome.report.totals.failed).toBe(failed)
    expect(outcome.report.totals.successful).toBe(184_312 - failed)
  }, 60_000)

  it('AC-4: a re-run leaves the published report unchanged and creates no second one', async () => {
    const { deps, store, signInSource } = setUp([signIn('2026-10-11T09:00:00.000Z')])
    const first = await generateReport(deps, '2026-10-11')
    if (first.outcome !== 'published') throw new Error(first.outcome)
    const callsBefore = signInSource.calls.length
    const again = await generateReport(deps, '2026-10-11')
    expect(again.outcome).toBe('unchanged')
    if (again.outcome !== 'unchanged') throw new Error(again.outcome)
    expect(again.report.contentHash).toBe(first.report.contentHash)
    expect(again.report).toEqual(first.report)
    expect(signInSource.calls.length).toBe(callsBefore)
    expect((await store.list()).filter((r) => r.reportDate === '2026-10-11')).toHaveLength(1)
  })

  it('AC-4: the content hash is deterministic for the same Graph data regardless of page order', async () => {
    const a = signIn('2026-10-11T01:00:00.000Z')
    const b = signIn('2026-10-11T02:00:00.000Z')
    const one = setUp([a, b])
    const two = setUp([b, a], { now: '2026-10-12T03:00:00Z' })
    const r1 = await generateReport(one.deps, '2026-10-11')
    const r2 = await generateReport(two.deps, '2026-10-11')
    if (r1.outcome !== 'published' || r2.outcome !== 'published') throw new Error('not published')
    expect(r1.report.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r1.report.contentHash).toBe(r2.report.contentHash)
  })

  it('AC-4: a concurrent publish that wins the race is returned, not duplicated', async () => {
    const { deps, store } = setUp([signIn('2026-10-11T09:00:00.000Z')])
    const racing = { ...store, publish: store.publish }
    let raced = false
    racing.findPublished = async (date: string) => {
      if (!raced) {
        raced = true
        return null
      }
      return store.findPublished(date)
    }
    // Another worker publishes first.
    await generateReport({ ...deps }, '2026-10-11')
    const outcome = await generateReport({ ...deps, store: racing }, '2026-10-11')
    expect(outcome.outcome).toBe('unchanged')
    expect((await store.list()).filter((r) => r.reportDate === '2026-10-11')).toHaveLength(1)
  })

  it('AC-5: Identity Protection failing until 07:00 publishes an incomplete report naming it', async () => {
    const { deps, clock, metrics } = setUp([signIn('2026-10-11T09:00:00.000Z')], { risk: { failAlways: true } })
    const outcome = await generateReport(deps, '2026-10-11')
    if (outcome.outcome !== 'published') throw new Error(outcome.outcome)
    expect(outcome.report.complete).toBe(false)
    expect(outcome.report.missingSources).toEqual([IDENTITY_PROTECTION_SOURCE])
    expect(IDENTITY_PROTECTION_SOURCE).toBe('Identity Protection risk data')
    expect(outcome.report.totals.total).toBe(1)
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(Date.parse('2026-10-12T07:00:00Z'))
    expect(Date.parse(outcome.report.publishedAt)).toBeLessThan(Date.parse('2026-10-12T08:00:00Z'))
    expect(metrics.data).toContainEqual(
      expect.objectContaining({ namespace: METRIC_NAMESPACE, name: METRICS.reportIncomplete, value: 1 }),
    )
  })

  it('AC-5: every Graph call failing until 07:00 records the day as not generated, never complete', async () => {
    const { deps, store, metrics } = setUp([signIn('2026-10-11T09:00:00.000Z')], {
      signIns: { failAlways: true },
      risk: { failAlways: true },
    })
    const outcome = await generateReport(deps, '2026-10-11')
    expect(outcome).toEqual({
      outcome: 'not-generated',
      reportDate: '2026-10-11',
      missingSources: [SIGN_IN_SOURCE, IDENTITY_PROTECTION_SOURCE],
    })
    expect(await store.findPublished('2026-10-11')).toBeNull()
    expect(await store.findNotGenerated('2026-10-11')).toMatchObject({
      reportDate: '2026-10-11',
      recordedAt: '2026-10-12T07:00:00.000Z',
      missingSources: [SIGN_IN_SOURCE, IDENTITY_PROTECTION_SOURCE],
    })
    expect((await store.list()).some((r) => r.reportDate === '2026-10-11' && r.complete)).toBe(false)
    expect(metrics.data).toContainEqual({
      namespace: METRIC_NAMESPACE,
      name: METRICS.reportNotGenerated,
      value: 1,
      dimensions: { reportDate: '2026-10-11' },
    })
  })

  it('AC-5: sign-ins failing alone is still not generated, since a report without them is meaningless', async () => {
    const { deps } = setUp([], { signIns: { failAlways: true } })
    const outcome = await generateReport(deps, '2026-10-11')
    expect(outcome).toMatchObject({ outcome: 'not-generated', missingSources: [SIGN_IN_SOURCE] })
  })

  it('AC-7: a day with no sign-ins still publishes a report with zero totals', async () => {
    const { deps, metrics } = setUp([])
    const outcome = await generateReport(deps, '2026-10-11')
    if (outcome.outcome !== 'published') throw new Error(outcome.outcome)
    expect(outcome.report.totals).toEqual({
      total: 0,
      successful: 0,
      failed: 0,
      byType: { interactiveUser: 0, nonInteractiveUser: 0, servicePrincipal: 0, managedIdentity: 0 },
    })
    expect(outcome.report.complete).toBe(true)
    expect(metrics.data).toContainEqual({
      namespace: METRIC_NAMESPACE,
      name: METRICS.reportPublished,
      value: 1,
      dimensions: { reportDate: '2026-10-11' },
    })
  })

  it('AC-8: the job only reads from Graph, and its identity holds only the four read permissions', async () => {
    expect([...GRAPH_PERMISSIONS].sort()).toEqual([
      'AuditLog.Read.All',
      'IdentityRiskEvent.Read.All',
      'IdentityRiskyUser.Read.All',
      'Policy.Read.All',
    ])
    for (const permission of GRAPH_PERMISSIONS) expect(permission).toMatch(/\.Read\.All$/)
    const touched: string[] = []
    const { deps } = setUp([signIn('2026-10-11T09:00:00.000Z')])
    const spy = <T extends object>(target: T, label: string): T =>
      new Proxy(target, {
        get(obj, key, receiver) {
          touched.push(`${label}.${String(key)}`)
          return Reflect.get(obj, key, receiver)
        },
      })
    await generateReport({ ...deps, signIns: spy(deps.signIns, 'signIns'), risk: spy(deps.risk, 'risk') }, '2026-10-11')
    expect(new Set(touched)).toEqual(new Set(['signIns.fetchSignInsPage', 'risk.fetchRiskDetectionsPage']))
  })

  it('stores risk detections inside the window in the snapshot', async () => {
    const { deps } = setUp([])
    const outcome = await generateReport(deps, '2026-10-11')
    if (outcome.outcome !== 'published') throw new Error(outcome.outcome)
    expect(outcome.report.riskDetections).toEqual([risk])
  })

  it('runs inside a span when a tracer is injected', async () => {
    const spans: { name: string; attributes: Record<string, string> }[] = []
    const { deps } = setUp([])
    await generateReport(
      {
        ...deps,
        tracer: {
          inSpan: (name, attributes, fn) => {
            spans.push({ name, attributes })
            return fn()
          },
        },
      },
      '2026-10-11',
    )
    expect(spans).toEqual([{ name: 'report.generate', attributes: { 'report.date': '2026-10-11' } }])
  })
})
