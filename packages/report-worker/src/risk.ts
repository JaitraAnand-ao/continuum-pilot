import {
  NOT_RECORDED,
  RISK_TRIGGER,
  RISKY_USER_TRIGGER,
  type RiskCategory,
  type RiskDetection,
  type RiskFlags,
  type RiskySignInFlag,
  type RiskyUser,
  type RiskyUserFlag,
  type SignIn,
  type SourceId,
} from './model.js'

/* The levels at or above the 'medium or higher' trigger; low, none, hidden and any future value fall below it. */
const TRIGGER_LEVELS: ReadonlySet<string> = new Set(['medium', 'high'])
const RISKY_STATES: ReadonlySet<string> = new Set(RISKY_USER_TRIGGER.riskStates)

/* Risky sign-ins come from every sign-in type and are only meaningful with Identity Protection read (AC-7). */
const RISKY_SIGN_IN_SOURCES: readonly SourceId[] = [
  'signIns.interactiveUser',
  'signIns.nonInteractiveUser',
  'signIns.servicePrincipal',
  'signIns.managedIdentity',
  'identityProtection.riskDetections',
]
/* A risky user lists its sign-ins in the window; only user sign-ins carry a user. */
const RISKY_USER_SOURCES: readonly SourceId[] = [
  'signIns.interactiveUser',
  'signIns.nonInteractiveUser',
  'identityProtection.riskDetections',
]

function recorded(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === '' ? NOT_RECORDED : value
}

function locationOf(signIn: SignIn): string {
  const { city, state, countryOrRegion } = signIn.location ?? {}
  const parts = [city, state, countryOrRegion].filter((part) => recorded(part) !== NOT_RECORDED)
  return parts.length === 0 ? NOT_RECORDED : parts.join(', ')
}

function deviceComplianceOf(signIn: SignIn): string {
  const isCompliant = signIn.deviceDetail?.isCompliant
  if (isCompliant === true) return 'compliant'
  if (isCompliant === false) return 'not compliant'
  return NOT_RECORDED
}

export function isRiskySignIn(signIn: SignIn): boolean {
  return TRIGGER_LEVELS.has(signIn.riskLevelAggregated ?? '')
}

export function isRiskyUser(user: RiskyUser): boolean {
  return RISKY_STATES.has(user.riskState) && TRIGGER_LEVELS.has(user.riskLevel)
}

/* One flag per sign-in at or above the trigger, carrying the trigger, the observed level and the evidence. */
export function riskySignInFlags(signIns: readonly SignIn[]): RiskySignInFlag[] {
  return signIns.filter(isRiskySignIn).map((signIn) => ({
    signInId: signIn.id,
    trigger: RISK_TRIGGER,
    observedRiskLevel: signIn.riskLevelAggregated as string,
    evidence: {
      requestId: recorded(signIn.correlationId),
      timestamp: signIn.createdDateTime,
      user: recorded(signIn.userPrincipalName),
      app: recorded(signIn.appDisplayName),
      ipAddress: recorded(signIn.ipAddress),
      location: locationOf(signIn),
      deviceCompliance: deviceComplianceOf(signIn),
      conditionalAccessResult: recorded(signIn.conditionalAccessStatus),
    },
  }))
}

/* One flag per qualifying user, with the day's detections and sign-ins that belong to that user. */
export function riskyUserFlags(
  users: readonly RiskyUser[],
  detections: readonly RiskDetection[],
  signIns: readonly SignIn[],
): RiskyUserFlag[] {
  return users.filter(isRiskyUser).map((user) => ({
    userId: user.id,
    user: recorded(user.userPrincipalName),
    trigger: RISKY_USER_TRIGGER,
    riskState: user.riskState,
    riskLevel: user.riskLevel,
    detections: detections
      .filter((detection) => detection.userId === user.id)
      .map((detection) => ({
        id: detection.id,
        type: detection.riskEventType,
        riskLevel: detection.riskLevel,
        detectedDateTime: detection.detectedDateTime,
      })),
    signInIds: signIns.filter((signIn) => signIn.userId === user.id).map((signIn) => signIn.id),
  }))
}

function category<F>(
  dependsOn: readonly SourceId[],
  missingSources: readonly SourceId[],
  flags: () => F[],
): RiskCategory<F> {
  const missing = dependsOn.filter((source) => missingSources.includes(source))
  return missing.length === 0 ? { evaluated: true, flags: flags() } : { evaluated: false, missingSources: missing }
}

/* Computed from the snapshot alone, so the stored flags always reconcile to the stored snapshot. */
export function evaluateRiskFlags(
  snapshot: { signIns: readonly SignIn[]; riskDetections: readonly RiskDetection[]; riskyUsers: readonly RiskyUser[] },
  missingSources: readonly SourceId[],
): RiskFlags {
  return {
    riskySignIns: category(RISKY_SIGN_IN_SOURCES, missingSources, () => riskySignInFlags(snapshot.signIns)),
    riskyUsers: category(RISKY_USER_SOURCES, missingSources, () =>
      riskyUserFlags(snapshot.riskyUsers, snapshot.riskDetections, snapshot.signIns),
    ),
  }
}
