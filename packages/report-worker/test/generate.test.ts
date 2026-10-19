import { describe, expect, it } from 'vitest'
import {
  generateReport,
  GraphThrottledError,
  previousUtcDate,
  publishDeadline,
  REPORT_COMPLETE,
  REPORT_JOB_GRAPH_PERMISSIONS,
  SIGN_IN_TYPES,
  SIGN_INS_COLLECTED,
  SOURCE_NAMES,
  totalsOf,
  type GenerateDeps,
  type RiskDetection,
  type SignIn,
} from '../src/index.js'
import {
  FakeClock,
  FakeSleeper,
  InMemoryReportStore,
  RecordingMetrics,
  riskDetection,
  ScriptedGraph,
  signIn,
} from './support/fakes.js'

function setup(
  data: { signIns?: SignIn[]; risk?: RiskDetection[]; pageSize?: number },
  at = '2026-10-12T02:00:00.000Z',
) {
  const clock = new FakeClock(at)
  const sleeper = new FakeSleeper(clock)
  const graph = new ScriptedGraph(clock, data)
  const store = new InMemoryReportStore()
  const metrics = new RecordingMetrics()
  const deps: GenerateDeps = { clock, sleeper, signIns: graph, risk: graph, store, metrics }
  return { clock, sleeper, graph, store, metrics, deps }
}

const oneOfEachType = () => SIGN_IN_TYPES.map((type) => signIn({ type }))

describe('Feature: Have yesterday’s sign-ins collected from Microsoft Graph and a report published by 08:00 UTC', () => {
  it('@AC-1 Scenario: One report per UTC day, ready by 08:00 UTC', async () => {
    const { deps, store, clock } = setup({ signIns: oneOfEachType() })
    const outcome = await generateReport(previousUtcDate(clock.now()), deps)

    expect(outcome.kind).toBe('published')
    const reports = store.listPublished().filter((report) => report.reportDate === '2026-10-11')
    expect(reports).toHaveLength(1)
    expect(reports[0]?.windowStart).toBe('2026-10-11T00:00:00.000Z')
    expect(reports[0]?.windowEnd).toBe('2026-10-12T00:00:00.000Z')
    expect(new Date(reports[0]?.publishedAt as string).getTime()).toBeLessThan(publishDeadline('2026-10-11').getTime())
  })

  it('@AC-1 Scenario: Fourteen days in a row', async () => {
    const { deps, store, clock } = setup({ signIns: oneOfEachType() }, '2026-10-05T02:00:00.000Z')
    for (let day = 0; day < 14; day += 1) {
      await generateReport(previousUtcDate(clock.now()), deps)
      clock.advance(24 * 3_600_000)
    }
    const dates = store.listPublished().map((report) => report.reportDate)
    expect(dates).toHaveLength(14)
    expect(new Set(dates).size).toBe(14)
    expect(dates[0]).toBe('2026-10-04')
    expect(dates[13]).toBe('2026-10-17')
  })

  it('@AC-1 asks Graph for exactly the report window and refuses a day that is not over', async () => {
    const { deps, graph, clock } = setup({ signIns: oneOfEachType() })
    await generateReport('2026-10-11', deps)
    for (const call of graph.calls) {
      expect(call.window.start.toISOString()).toBe('2026-10-11T00:00:00.000Z')
      expect(call.window.end.toISOString()).toBe('2026-10-12T00:00:00.000Z')
    }
    await expect(generateReport(clock.now().toISOString().slice(0, 10), deps)).rejects.toThrow('not over yet')
  })

  it('@AC-2 Scenario: All four sign-in types are collected with their CA results and device details', async () => {
    const signIns = oneOfEachType()
    const { deps, store } = setup({ signIns })
    await generateReport('2026-10-11', deps)

    const snapshot = store.snapshot('2026-10-11')?.signIns ?? []
    expect(new Set(snapshot.map((stored) => stored.type))).toEqual(new Set(SIGN_IN_TYPES))
    for (const stored of snapshot) {
      const original = signIns.find((candidate) => candidate.id === stored.id)
      expect(stored.conditionalAccessPolicies).toEqual(original?.conditionalAccessPolicies)
      expect(stored.conditionalAccessPolicies.length).toBeGreaterThan(0)
      expect(stored.device).toEqual(original?.device)
    }
  })

  it('@AC-2 Scenario: Window boundaries are exact', async () => {
    const lastInstant = signIn({ createdAt: '2026-10-11T23:59:59.999Z' })
    const nextDay = signIn({ createdAt: '2026-10-12T00:00:00.000Z' })
    const firstInstant = signIn({ createdAt: '2026-10-11T00:00:00.000Z' })
    const dayBefore = signIn({ createdAt: '2026-10-10T23:59:59.999Z' })
    const { deps, store } = setup({ signIns: [lastInstant, nextDay, firstInstant, dayBefore] })
    await generateReport('2026-10-11', deps)

    const ids = store.snapshot('2026-10-11')?.signIns.map((stored) => stored.id)
    expect(ids).toContain(lastInstant.id)
    expect(ids).not.toContain(nextDay.id)
    expect(ids).toContain(firstInstant.id)
    expect(ids).not.toContain(dayBefore.id)
  })

  it('@AC-3 Scenario: Paging and throttling do not lose sign-ins', async () => {
    const signIns = Array.from({ length: 184_312 }, (_, index) =>
      signIn({
        type: SIGN_IN_TYPES[index % 4],
        errorCode: index % 10 === 0 ? 50126 : 0,
        createdAt: new Date(Date.UTC(2026, 9, 11) + (index % 86_400_000)).toISOString(),
      }),
    )
    const { deps, store, graph } = setup({ signIns, pageSize: 999 })
    let throttled = false
    graph.failWith = (call) => {
      if (!throttled && call.source === 'servicePrincipal' && call.cursor === '9990') {
        throttled = true
        return new GraphThrottledError(5)
      }
      return undefined
    }

    const outcome = await generateReport('2026-10-11', deps)

    const pageRequests = graph.calls.filter((call) => call.source === 'servicePrincipal' && call.cursor === '9990')
    expect(pageRequests).toHaveLength(2)
    expect((pageRequests[1]?.at as number) - (pageRequests[0]?.at as number)).toBeGreaterThanOrEqual(5000)
    expect(store.snapshot('2026-10-11')?.signIns).toHaveLength(184_312)
    expect(outcome.kind === 'published' && outcome.report.totals).toEqual(totalsOf(signIns))
    expect(outcome.kind === 'published' && outcome.report.complete).toBe(true)
  }, 60_000)

  it('@AC-3 counts a sign-in that Graph repeats across pages once', async () => {
    const repeated = signIn()
    const { deps, store, graph } = setup({ signIns: [repeated, signIn()], pageSize: 1 })
    graph.fetchSignInPage = async (type, window, cursor) =>
      type === 'interactiveUser'
        ? cursor === undefined
          ? { items: [repeated], nextCursor: 'b' }
          : { items: [repeated] }
        : { items: [] }
    await generateReport('2026-10-11', deps)
    expect(store.snapshot('2026-10-11')?.signIns).toHaveLength(1)
  })

  it('@AC-4 Scenario: A re-run does not duplicate or alter a published report', async () => {
    const { deps, store, graph } = setup({ signIns: oneOfEachType(), risk: [riskDetection()] })
    const first = await generateReport('2026-10-11', deps)
    const callsAfterFirst = graph.calls.length

    const second = await generateReport('2026-10-11', deps)

    expect(store.listPublished().filter((report) => report.reportDate === '2026-10-11')).toHaveLength(1)
    expect(second.kind).toBe('already-published')
    expect(second.kind === 'already-published' && second.report).toEqual(first.kind === 'published' && first.report)
    expect(graph.calls.length).toBe(callsAfterFirst)
  })

  it('@AC-4 keeps the report that won a concurrent publish', async () => {
    const { deps, store } = setup({ signIns: oneOfEachType() })
    const [a, b] = await Promise.all([generateReport('2026-10-11', deps), generateReport('2026-10-11', deps)])
    expect(store.listPublished()).toHaveLength(1)
    expect([a, b].filter((outcome) => outcome.kind === 'published' && outcome.created)).toHaveLength(1)
  })

  it('@AC-5 Scenario: Graph keeps failing until the retry deadline', async () => {
    const { deps, store, graph, clock } = setup({ signIns: oneOfEachType(), risk: [riskDetection()] })
    graph.failWith = (call) => (call.source === 'risk' ? new Error('503 Service Unavailable') : undefined)

    const outcome = await generateReport('2026-10-11', deps)

    expect(clock.now().getTime()).toBeLessThanOrEqual(new Date('2026-10-12T07:00:00.000Z').getTime())
    const lastRisk = graph.calls.filter((call) => call.source === 'risk').at(-1)
    expect(lastRisk?.at).toBeGreaterThan(new Date('2026-10-12T06:45:00.000Z').getTime())
    expect(outcome.kind).toBe('published')
    const report = store.listPublished()[0]
    expect(report?.complete).toBe(false)
    expect(report?.missingSources).toEqual([SOURCE_NAMES.identityProtection])
    expect(report?.missingSources).toEqual(['Identity Protection risk data'])
    expect(store.snapshot('2026-10-11')?.signIns).toHaveLength(4)
  })

  it('@AC-5 names each sign-in type it could not collect and drops that type’s partial pages', async () => {
    const { deps, store, graph } = setup({
      signIns: [...oneOfEachType(), signIn({ type: 'managedIdentity' }), signIn({ type: 'managedIdentity' })],
      pageSize: 1,
    })
    graph.failWith = (call) => (call.source === 'managedIdentity' && call.cursor === '1' ? new Error('500') : undefined)

    await generateReport('2026-10-11', deps)

    const report = store.listPublished()[0]
    expect(report?.complete).toBe(false)
    expect(report?.missingSources).toEqual([SOURCE_NAMES.managedIdentity])
    expect(store.snapshot('2026-10-11')?.signIns.map((stored) => stored.type)).not.toContain('managedIdentity')
    expect(report?.totals.total).toBe(3)
  })

  it('@AC-5 Scenario: Nothing at all could be collected', async () => {
    const { deps, store, graph, metrics } = setup({ signIns: oneOfEachType(), risk: [riskDetection()] })
    graph.failWith = () => new Error('500 Internal Server Error')

    const outcome = await generateReport('2026-10-11', deps)

    expect(outcome.kind).toBe('not-generated')
    expect(store.notGenerated.get('2026-10-11')).toEqual(Object.values(SOURCE_NAMES))
    expect(store.listPublished()).toHaveLength(0)
    expect(await store.findPublished('2026-10-11')).toBeUndefined()
    expect(metrics.last(REPORT_COMPLETE)).toEqual({
      name: REPORT_COMPLETE,
      value: 0,
      properties: { reportDate: '2026-10-11' },
    })
  })

  it('@AC-5 records the day as not generated when every sign-in type fails even though risk data came back', async () => {
    const { deps, store, graph } = setup({ signIns: oneOfEachType(), risk: [riskDetection()] })
    graph.failWith = (call) => (call.source === 'risk' ? undefined : new GraphThrottledError(600))

    const outcome = await generateReport('2026-10-11', deps)

    expect(outcome.kind).toBe('not-generated')
    expect(store.listPublished()).toHaveLength(0)
  })

  it('@AC-6 tells the alarm whether each run left a complete report', async () => {
    const complete = setup({ signIns: oneOfEachType() })
    await generateReport('2026-10-11', complete.deps)
    expect(complete.metrics.last(REPORT_COMPLETE)?.value).toBe(1)
    expect(complete.metrics.last(SIGN_INS_COLLECTED)?.value).toBe(4)
    await generateReport('2026-10-11', complete.deps)
    expect(complete.metrics.last(REPORT_COMPLETE)?.value).toBe(1)

    const incomplete = setup({ signIns: oneOfEachType() })
    incomplete.graph.failWith = (call) => (call.source === 'risk' ? new Error('503') : undefined)
    await generateReport('2026-10-11', incomplete.deps)
    expect(incomplete.metrics.last(REPORT_COMPLETE)?.value).toBe(0)
    await generateReport('2026-10-11', incomplete.deps)
    expect(incomplete.metrics.last(REPORT_COMPLETE)?.value).toBe(0)
  })

  it('@AC-7 Scenario: A day without sign-ins still has a report', async () => {
    const { deps, store } = setup({ signIns: [] })
    const outcome = await generateReport('2026-10-11', deps)

    expect(outcome.kind).toBe('published')
    const report = await store.findPublished('2026-10-11')
    expect(report?.complete).toBe(true)
    expect(report?.totals).toEqual({ total: 0, successful: 0, failed: 0 })
  })

  it('@AC-8 Scenario: The job changes nothing in the tenant', async () => {
    const { deps, graph } = setup({ signIns: oneOfEachType(), risk: [riskDetection()] })
    const reads = new Set(['fetchSignInPage', 'fetchRiskDetectionPage'])
    const used = new Set<string>()
    const spy = new Proxy(graph, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value === 'function') used.add(String(property))
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    await generateReport('2026-10-11', { ...deps, signIns: spy, risk: spy })

    expect([...used].every((name) => reads.has(name))).toBe(true)
    expect([...REPORT_JOB_GRAPH_PERMISSIONS].sort()).toEqual([
      'AuditLog.Read.All',
      'IdentityRiskEvent.Read.All',
      'IdentityRiskyUser.Read.All',
      'Policy.Read.All',
    ])
    expect(REPORT_JOB_GRAPH_PERMISSIONS.every((permission) => /\.Read\.All$/.test(permission))).toBe(true)
  })

  it('keeps risk detections from the window in the snapshot', async () => {
    const inside = riskDetection({ detectedAt: '2026-10-11T23:59:59.999Z' })
    const outside = riskDetection({ detectedAt: '2026-10-12T00:00:00.000Z' })
    const { deps, store } = setup({ signIns: oneOfEachType(), risk: [inside, outside] })
    await generateReport('2026-10-11', deps)
    expect(store.snapshot('2026-10-11')?.riskDetections.map((risk) => risk.id)).toEqual([inside.id])
  })
})
