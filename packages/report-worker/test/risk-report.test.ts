import { describe, expect, it } from 'vitest'
import {
  contentHash,
  evaluateRiskFlags,
  generateReport,
  NOT_RECORDED,
  snapshotHashInput,
  SOURCE_LABELS,
  type PublishedReport,
  type RiskDetection,
  type RiskyUser,
  type SignIn,
} from '../src/index.js'
import { FakeClock, FakeGraph, MemoryStore, RecordingMetrics, riskDetection, riskyUser, signIn } from './support.js'

const DAY = '2026-10-11'

async function generate(
  signIns: SignIn[],
  risks: RiskDetection[] = [],
  users: RiskyUser[] = [],
  configure: (graph: FakeGraph) => void = () => undefined,
  pageSize = 1000,
): Promise<{ report: PublishedReport; graph: FakeGraph; clock: FakeClock }> {
  const graph = new FakeGraph(signIns, risks, pageSize, users)
  configure(graph)
  const store = new MemoryStore()
  const clock = new FakeClock('2026-10-12T02:00:00.000Z')
  const outcome = await generateReport(DAY, { graph, store, metrics: new RecordingMetrics(), clock })
  if (outcome.kind !== 'published') throw new Error(`expected published, got ${outcome.kind}`)
  return { report: store.reports.get(DAY)!, graph, clock }
}

function riskySignInsOf(report: PublishedReport) {
  if (!report.riskFlags.riskySignIns.evaluated) throw new Error('risky sign-ins not evaluated')
  return report.riskFlags.riskySignIns.flags
}

function riskyUsersOf(report: PublishedReport) {
  if (!report.riskFlags.riskyUsers.evaluated) throw new Error('risky users not evaluated')
  return report.riskFlags.riskyUsers.flags
}

describe('AC-1: risk data is collected into the snapshot', () => {
  it('Identity Protection holds 6 risk detections and 3 risky users for 11 October 2026 → the snapshot holds them', async () => {
    const risks = Array.from({ length: 6 }, (_, i) => riskDetection({ id: `rd-${i + 1}` }))
    const users = [
      riskyUser({ id: 'u-1' }),
      riskyUser({ id: 'u-2', riskState: 'dismissed' }),
      riskyUser({ id: 'u-3', riskLevel: 'low' }),
    ]
    /* A page size of 2 makes both Identity Protection endpoints follow their next links. */
    const { report, graph } = await generate([], risks, users, () => undefined, 2)

    expect(report.status).toBe('complete')
    expect(report.riskDetections).toEqual(risks)
    expect(report.riskyUsers).toEqual(users)
    expect(graph.calls.filter((call) => call.startsWith('riskyUsers:'))).toEqual(['riskyUsers:0', 'riskyUsers:2'])
  })

  it('the hash covers the risky users and the flags, so neither can change unnoticed', async () => {
    const { report } = await generate(
      [signIn({ id: 's', riskLevelAggregated: 'high' })],
      [],
      [riskyUser({ id: 'u-1' })],
    )
    expect(report.contentHash).toBe(contentHash(snapshotHashInput(report)))
    expect(contentHash(snapshotHashInput({ ...report, riskyUsers: [] }))).not.toBe(report.contentHash)
    const lessFlags = { ...report, riskFlags: { ...report.riskFlags, riskySignIns: { evaluated: true, flags: [] } } }
    expect(contentHash(snapshotHashInput(lessFlags as PublishedReport))).not.toBe(report.contentHash)
  })

  it('the stored flags reconcile to the stored snapshot', async () => {
    const { report } = await generate(
      [
        signIn({ id: 's-1', userId: 'u-1', riskLevelAggregated: 'high' }),
        signIn({ id: 's-2', userId: 'u-2', riskLevelAggregated: 'low' }),
      ],
      [riskDetection({ id: 'rd-1', userId: 'u-1' })],
      [riskyUser({ id: 'u-1' }), riskyUser({ id: 'u-2', riskLevel: 'medium' })],
    )
    expect(report.riskFlags).toEqual(evaluateRiskFlags(report, report.missingSources))
    expect(riskySignInsOf(report)).toHaveLength(1)
    expect(riskyUsersOf(report)).toHaveLength(2)
  })
})

describe('AC-2: risky sign-in trigger and its boundary', () => {
  it.each([
    ['high', 1],
    ['medium', 1],
    ['low', 0],
    ['none', 0],
  ])('a sign-in with aggregated risk level %s → %i risky sign-in flags for it', async (level, count) => {
    const { report } = await generate([signIn({ id: 'target', riskLevelAggregated: level })])
    expect(riskySignInsOf(report).filter((flag) => flag.signInId === 'target')).toHaveLength(count)
  })
})

describe('AC-3: risky user trigger and its boundary', () => {
  it.each([
    ['atRisk', 'high', 1],
    ['confirmedCompromised', 'medium', 1],
    ['atRisk', 'low', 0],
    ['remediated', 'high', 0],
    ['dismissed', 'high', 0],
    ['none', 'none', 0],
  ])('j.morales with riskState %s and riskLevel %s → %i risky user flags', async (riskState, riskLevel, count) => {
    const { report } = await generate(
      [],
      [],
      [riskyUser({ id: 'u-jm', userPrincipalName: 'j.morales@contoso.example', riskState, riskLevel })],
    )
    expect(riskyUsersOf(report).filter((flag) => flag.user === 'j.morales@contoso.example')).toHaveLength(count)
  })
})

describe('AC-4: a risky sign-in flag carries its evidence', () => {
  it('d.chen at high to Exchange Online → trigger medium or higher against high, with the full evidence', async () => {
    const { report } = await generate([
      signIn({
        id: 'si-chen',
        correlationId: 'req-chen',
        createdDateTime: '2026-10-11T08:42:10.123Z',
        userId: 'u-chen',
        userPrincipalName: 'd.chen@contoso.example',
        appDisplayName: 'Exchange Online',
        ipAddress: '198.51.100.23',
        location: { city: 'Rotterdam', state: 'Zuid-Holland', countryOrRegion: 'NL' },
        deviceDetail: {
          deviceId: 'd',
          operatingSystem: 'macOS',
          browser: 'Safari',
          isCompliant: false,
          isManaged: false,
        },
        conditionalAccessStatus: 'notApplied',
        riskLevelAggregated: 'high',
      }),
    ])
    const [flag] = riskySignInsOf(report)
    expect(flag).toMatchObject({ signInId: 'si-chen', trigger: 'medium or higher', observedRiskLevel: 'high' })
    expect(flag!.evidence).toEqual({
      requestId: 'req-chen',
      timestamp: '2026-10-11T08:42:10.123Z',
      user: 'd.chen@contoso.example',
      app: 'Exchange Online',
      ipAddress: '198.51.100.23',
      location: 'Rotterdam, Zuid-Holland, NL',
      deviceCompliance: 'not compliant',
      conditionalAccessResult: 'notApplied',
    })
  })
})

describe('AC-5: a risky user flag carries its detections and linked sign-ins', () => {
  it('j.morales atRisk at high with two detections and 4 sign-ins on the day', async () => {
    const jm = 'u-jm'
    const signIns = [
      signIn({ id: 's-1', userId: jm, createdDateTime: '2026-10-11T00:00:00.000Z' }),
      signIn({ id: 's-2', userId: jm, signInEventType: 'nonInteractiveUser' }),
      signIn({ id: 's-3', userId: jm, createdDateTime: '2026-10-11T18:30:00.000Z' }),
      signIn({ id: 's-4', userId: jm, createdDateTime: '2026-10-11T23:59:59.999Z' }),
      /* Outside the window: Graph's lax end bound returns it, the snapshot does not keep it. */
      signIn({ id: 's-next-day', userId: jm, createdDateTime: '2026-10-12T00:00:00.000Z' }),
      signIn({ id: 's-other', userId: 'u-other' }),
    ]
    const risks = [
      riskDetection({
        id: 'rd-a',
        userId: jm,
        riskEventType: 'unlikelyTravel',
        riskLevel: 'high',
        detectedDateTime: '2026-10-11T06:00:00.000Z',
      }),
      riskDetection({
        id: 'rd-b',
        userId: jm,
        riskEventType: 'maliciousIPAddress',
        riskLevel: 'medium',
        detectedDateTime: '2026-10-11T07:00:00.000Z',
      }),
      riskDetection({ id: 'rd-other', userId: 'u-other' }),
    ]
    const { report } = await generate(signIns, risks, [
      riskyUser({ id: jm, userPrincipalName: 'j.morales@contoso.example', riskState: 'atRisk', riskLevel: 'high' }),
    ])
    const [flag] = riskyUsersOf(report)
    expect(flag).toMatchObject({ user: 'j.morales@contoso.example', riskState: 'atRisk', riskLevel: 'high' })
    expect(flag!.detections).toEqual([
      { id: 'rd-a', type: 'unlikelyTravel', riskLevel: 'high', detectedDateTime: '2026-10-11T06:00:00.000Z' },
      { id: 'rd-b', type: 'maliciousIPAddress', riskLevel: 'medium', detectedDateTime: '2026-10-11T07:00:00.000Z' },
    ])
    expect([...flag!.signInIds].sort()).toEqual(['s-1', 's-2', 's-3', 's-4'])
  })
})

describe('AC-6: a blank field from Entra does not suppress the flag', () => {
  it('a high-risk sign-in with no location → the flag is raised with location not recorded', async () => {
    const { report } = await generate([
      signIn({
        id: 'no-location',
        riskLevelAggregated: 'high',
        location: { city: null, state: null, countryOrRegion: null },
      }),
    ])
    const flags = riskySignInsOf(report)
    expect(flags).toHaveLength(1)
    expect(flags[0]!.evidence.location).toBe(NOT_RECORDED)
    expect(flags[0]!.evidence.location).toBe('not recorded')
  })
})

describe('AC-7: Identity Protection could not be read', () => {
  it('both endpoints fail until 07:00 UTC → incomplete naming Identity Protection risk data, categories not evaluated', async () => {
    const { report, clock } = await generate(
      [signIn({ id: 's-1', riskLevelAggregated: 'high' })],
      [riskDetection({ id: 'rd-1' })],
      [riskyUser({ id: 'u-1' })],
      (graph) => {
        graph.failRisk = 'always'
      },
    )
    expect(report.status).toBe('incomplete')
    expect(report.missingSources).toEqual(['identityProtection.riskDetections'])
    expect(report.missingSources.map((source) => SOURCE_LABELS[source])).toEqual(['Identity Protection risk data'])
    expect(report.riskFlags).toEqual({
      riskySignIns: { evaluated: false, missingSources: ['identityProtection.riskDetections'] },
      riskyUsers: { evaluated: false, missingSources: ['identityProtection.riskDetections'] },
    })
    expect(report.riskFlags.riskySignIns).not.toHaveProperty('flags')
    expect(report.riskFlags.riskyUsers).not.toHaveProperty('flags')
    expect(report.riskDetections).toEqual([])
    expect(report.riskyUsers).toEqual([])
    expect(report.totals.total).toBe(1)
    expect(clock.now().getTime()).toBeLessThan(Date.parse('2026-10-12T07:00:00.000Z'))
  })

  it('only the risky user endpoint failing still marks Identity Protection missing and stores no partial risk data', async () => {
    const { report } = await generate([], [riskDetection({ id: 'rd-1' })], [riskyUser({ id: 'u-1' })], (graph) => {
      graph.failRiskyUsers = 'always'
    })
    expect(report.status).toBe('incomplete')
    expect(report.missingSources).toEqual(['identityProtection.riskDetections'])
    expect(report.riskFlags.riskySignIns.evaluated).toBe(false)
    expect(report.riskFlags.riskyUsers.evaluated).toBe(false)
    expect(report.riskDetections).toEqual([])
    expect(report.riskyUsers).toEqual([])
  })

  it('a day with Identity Protection read and nothing risky presents a real 0, evaluated', async () => {
    const { report } = await generate([signIn({ id: 's-1', riskLevelAggregated: 'low' })])
    expect(report.riskFlags).toEqual({
      riskySignIns: { evaluated: true, flags: [] },
      riskyUsers: { evaluated: true, flags: [] },
    })
  })
})
