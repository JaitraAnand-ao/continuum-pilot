import { describe, expect, it } from 'vitest'
import {
  evaluateRiskFlags,
  isRiskySignIn,
  isRiskyUser,
  NOT_RECORDED,
  RISK_TRIGGER,
  RISKY_USER_TRIGGER,
  riskySignInFlags,
  riskyUserFlags,
  SOURCES,
  type SourceId,
} from '../src/index.js'
import { riskDetection, riskyUser, signIn } from './support.js'

describe('AC-2: the risky sign-in trigger is aggregated risk medium or higher', () => {
  it.each([
    ['high', true],
    ['medium', true],
    ['low', false],
    ['none', false],
    ['hidden', false],
    ['unknownFutureValue', false],
  ])('aggregated risk %s → flagged %s', (level, flagged) => {
    expect(isRiskySignIn(signIn({ id: 's', riskLevelAggregated: level }))).toBe(flagged)
  })

  it('a sign-in with no aggregated risk level recorded is not flagged', () => {
    expect(isRiskySignIn(signIn({ id: 's', riskLevelAggregated: null }))).toBe(false)
    expect(isRiskySignIn(signIn({ id: 's', riskLevelAggregated: undefined }))).toBe(false)
  })

  it('raises exactly one flag per risky sign-in and none for the rest', () => {
    const flags = riskySignInFlags([
      signIn({ id: 'h', riskLevelAggregated: 'high' }),
      signIn({ id: 'm', riskLevelAggregated: 'medium' }),
      signIn({ id: 'l', riskLevelAggregated: 'low' }),
      signIn({ id: 'n', riskLevelAggregated: 'none' }),
    ])
    expect(flags.map((flag) => flag.signInId)).toEqual(['h', 'm'])
  })
})

describe('AC-3: the risky user trigger', () => {
  it.each([
    ['atRisk', 'high', true],
    ['atRisk', 'medium', true],
    ['confirmedCompromised', 'high', true],
    ['confirmedCompromised', 'medium', true],
    ['atRisk', 'low', false],
    ['confirmedCompromised', 'low', false],
    ['atRisk', 'none', false],
    ['atRisk', 'hidden', false],
    ['remediated', 'high', false],
    ['dismissed', 'high', false],
    ['confirmedSafe', 'high', false],
    ['none', 'none', false],
    ['unknownFutureValue', 'high', false],
  ])('riskState %s at riskLevel %s → flagged %s', (riskState, riskLevel, flagged) => {
    expect(isRiskyUser(riskyUser({ id: 'u', riskState, riskLevel }))).toBe(flagged)
  })
})

describe('AC-4 and AC-6: the risky sign-in flag stores its trigger and evidence', () => {
  it('stores the trigger against the observed level and every evidence field', () => {
    const [flag] = riskySignInFlags([
      signIn({
        id: 'si-1',
        correlationId: 'req-1',
        createdDateTime: '2026-10-11T09:15:00.000Z',
        userId: 'u-chen',
        userPrincipalName: 'd.chen@contoso.example',
        appDisplayName: 'Exchange Online',
        ipAddress: '198.51.100.7',
        location: { city: 'Lagos', state: 'Lagos', countryOrRegion: 'NG' },
        deviceDetail: {
          deviceId: 'd',
          operatingSystem: 'Windows',
          browser: 'Edge',
          isCompliant: false,
          isManaged: true,
        },
        conditionalAccessStatus: 'failure',
        riskLevelAggregated: 'high',
      }),
    ])
    expect(flag).toEqual({
      signInId: 'si-1',
      trigger: 'medium or higher',
      observedRiskLevel: 'high',
      evidence: {
        requestId: 'req-1',
        timestamp: '2026-10-11T09:15:00.000Z',
        user: 'd.chen@contoso.example',
        app: 'Exchange Online',
        ipAddress: '198.51.100.7',
        location: 'Lagos, Lagos, NG',
        deviceCompliance: 'not compliant',
        conditionalAccessResult: 'failure',
      },
    })
    expect(RISK_TRIGGER).toBe('medium or higher')
  })

  it('reports a compliant device as compliant and leaves out blank location parts', () => {
    const [flag] = riskySignInFlags([
      signIn({
        id: 's',
        riskLevelAggregated: 'medium',
        location: { city: '', state: null, countryOrRegion: 'GB' },
        deviceDetail: { deviceId: 'd', operatingSystem: 'iOS', browser: 'Safari', isCompliant: true, isManaged: true },
      }),
    ])
    expect(flag!.evidence.location).toBe('GB')
    expect(flag!.evidence.deviceCompliance).toBe('compliant')
  })

  it.each([
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['absent', undefined],
  ])('stores every %s evidence field as not recorded and still raises the flag', (_, blank) => {
    const flags = riskySignInFlags([
      signIn({
        id: 's',
        riskLevelAggregated: 'high',
        correlationId: blank,
        userPrincipalName: blank,
        /* Typed as a string since ST-3, but Graph can still send it empty or null. */
        appDisplayName: blank as string,
        ipAddress: blank,
        location: { city: blank, state: blank, countryOrRegion: blank },
        conditionalAccessStatus: blank,
        deviceDetail: { deviceId: '', operatingSystem: '', browser: '', isCompliant: null, isManaged: false },
      }),
    ])
    expect(flags).toHaveLength(1)
    expect(flags[0]!.evidence).toEqual({
      requestId: NOT_RECORDED,
      timestamp: '2026-10-11T12:00:00.000Z',
      user: NOT_RECORDED,
      app: NOT_RECORDED,
      ipAddress: NOT_RECORDED,
      location: NOT_RECORDED,
      deviceCompliance: NOT_RECORDED,
      conditionalAccessResult: NOT_RECORDED,
    })
    expect(NOT_RECORDED).toBe('not recorded')
  })

  it('stores a missing location object or device detail as not recorded', () => {
    const bare = signIn({ id: 's', riskLevelAggregated: 'high', location: null })
    const [flag] = riskySignInFlags([{ ...bare, deviceDetail: undefined as never }])
    expect(flag!.evidence.location).toBe(NOT_RECORDED)
    expect(flag!.evidence.deviceCompliance).toBe(NOT_RECORDED)
  })
})

describe('AC-5: the risky user flag stores its detections and the sign-ins in the window', () => {
  it('lists the user’s detections and sign-in IDs, and nobody else’s', () => {
    const flags = riskyUserFlags(
      [
        riskyUser({
          id: 'u-jm',
          userPrincipalName: 'j.morales@contoso.example',
          riskState: 'atRisk',
          riskLevel: 'high',
        }),
      ],
      [
        riskDetection({
          id: 'rd-1',
          userId: 'u-jm',
          riskEventType: 'unlikelyTravel',
          riskLevel: 'high',
          detectedDateTime: '2026-10-11T03:00:00.000Z',
        }),
        riskDetection({ id: 'rd-other', userId: 'u-other' }),
        riskDetection({
          id: 'rd-2',
          userId: 'u-jm',
          riskEventType: 'anonymizedIPAddress',
          riskLevel: 'medium',
          detectedDateTime: '2026-10-11T04:00:00.000Z',
        }),
      ],
      [
        signIn({ id: 's-1', userId: 'u-jm' }),
        signIn({ id: 's-x', userId: 'u-other' }),
        signIn({ id: 's-2', userId: 'u-jm' }),
      ],
    )
    expect(flags).toEqual([
      {
        userId: 'u-jm',
        user: 'j.morales@contoso.example',
        trigger: { riskStates: ['atRisk', 'confirmedCompromised'], riskLevel: 'medium or higher' },
        riskState: 'atRisk',
        riskLevel: 'high',
        detections: [
          { id: 'rd-1', type: 'unlikelyTravel', riskLevel: 'high', detectedDateTime: '2026-10-11T03:00:00.000Z' },
          {
            id: 'rd-2',
            type: 'anonymizedIPAddress',
            riskLevel: 'medium',
            detectedDateTime: '2026-10-11T04:00:00.000Z',
          },
        ],
        signInIds: ['s-1', 's-2'],
      },
    ])
    expect(RISKY_USER_TRIGGER).toEqual({
      riskStates: ['atRisk', 'confirmedCompromised'],
      riskLevel: 'medium or higher',
    })
  })

  it('raises one flag per qualifying user, none for the rest, and stores a blank UPN as not recorded', () => {
    const flags = riskyUserFlags(
      [
        riskyUser({ id: 'a', userPrincipalName: null }),
        riskyUser({ id: 'b', riskLevel: 'low' }),
        riskyUser({ id: 'c', riskState: 'dismissed' }),
      ],
      [],
      [],
    )
    expect(flags.map((flag) => flag.userId)).toEqual(['a'])
    expect(flags[0]!.user).toBe(NOT_RECORDED)
    expect(flags[0]!.detections).toEqual([])
    expect(flags[0]!.signInIds).toEqual([])
  })
})

describe('AC-7: a category whose data is missing is not evaluated, never a quiet zero', () => {
  const snapshot = {
    signIns: [signIn({ id: 's', userId: 'u', riskLevelAggregated: 'high' })],
    riskDetections: [riskDetection({ id: 'rd', userId: 'u' })],
    riskyUsers: [riskyUser({ id: 'u' })],
  }

  it('evaluates both categories when every source was collected', () => {
    const flags = evaluateRiskFlags(snapshot, [])
    expect(flags.riskySignIns).toMatchObject({ evaluated: true, flags: [{ signInId: 's' }] })
    expect(flags.riskyUsers).toMatchObject({ evaluated: true, flags: [{ userId: 'u', signInIds: ['s'] }] })
  })

  it('evaluates both categories as an empty list, a real 0, when nothing is risky', () => {
    expect(evaluateRiskFlags({ signIns: [], riskDetections: [], riskyUsers: [] }, [])).toEqual({
      riskySignIns: { evaluated: true, flags: [] },
      riskyUsers: { evaluated: true, flags: [] },
    })
  })

  it('marks both categories not evaluated, naming the source, when Identity Protection is missing', () => {
    expect(evaluateRiskFlags(snapshot, ['identityProtection.riskDetections'])).toEqual({
      riskySignIns: { evaluated: false, missingSources: ['identityProtection.riskDetections'] },
      riskyUsers: { evaluated: false, missingSources: ['identityProtection.riskDetections'] },
    })
  })

  it.each(SOURCES.filter((source) => source.startsWith('signIns.')))(
    'marks risky sign-ins not evaluated when %s is missing',
    (source) => {
      const flags = evaluateRiskFlags(snapshot, [source])
      expect(flags.riskySignIns).toEqual({ evaluated: false, missingSources: [source] })
    },
  )

  it.each<[SourceId, boolean]>([
    ['signIns.interactiveUser', false],
    ['signIns.nonInteractiveUser', false],
    ['signIns.servicePrincipal', true],
    ['signIns.managedIdentity', true],
  ])('risky users with %s missing → evaluated %s (only user sign-ins link to a user)', (source, evaluated) => {
    expect(evaluateRiskFlags(snapshot, [source]).riskyUsers.evaluated).toBe(evaluated)
  })
})
