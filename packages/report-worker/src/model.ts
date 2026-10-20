import type { DailyFigures } from './figures.js'

/* The shapes the report job reads from Graph (through the IF-13 port) and stores (through the IF-14 port). */

export const SIGN_IN_TYPES = ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity'] as const
export type SignInType = (typeof SIGN_IN_TYPES)[number]

export interface ConditionalAccessPolicyResult {
  id: string
  displayName: string
  /* Kept as Graph's string: the enum grows (unknownFutureValue) and the snapshot must not drop a value. */
  result: string
}

export interface DeviceDetail {
  deviceId: string
  operatingSystem: string
  browser: string
  /* Null when Entra did not record the device's compliance. */
  isCompliant: boolean | null
  isManaged: boolean
}

export interface SignIn {
  id: string
  createdDateTime: string
  signInEventType: SignInType
  /* 0 is a successful sign-in; any other code is a failure. */
  errorCode: number
  /* The application signed in to, for the per-application table (ST-3 AC-2). */
  appId: string
  appDisplayName: string
  conditionalAccessPolicies: readonly ConditionalAccessPolicyResult[]
  deviceDetail: DeviceDetail
  /* The evidence a risky sign-in flag carries. Entra may leave any of these null or empty. */
  correlationId?: string | null
  userId?: string | null
  userPrincipalName?: string | null
  ipAddress?: string | null
  location?: SignInLocation | null
  /* Kept as Graph's string (low, medium, high, hidden, none, unknownFutureValue). */
  riskLevelAggregated?: string | null
  conditionalAccessStatus?: string | null
}

export interface SignInLocation {
  city?: string | null
  state?: string | null
  countryOrRegion?: string | null
}

export interface RiskDetection {
  id: string
  detectedDateTime: string
  riskLevel: string
  riskEventType: string
  userId?: string | null
}

/* A user Identity Protection holds risk state for; riskState and riskLevel are kept as Graph's strings. */
export interface RiskyUser {
  id: string
  userPrincipalName?: string | null
  riskState: string
  riskLevel: string
  riskLastUpdatedDateTime?: string | null
}

/* What an evidence field holds when Entra left it empty (AC-6). */
export const NOT_RECORDED = 'not recorded'

export const RISK_TRIGGER = 'medium or higher'

export const RISKY_USER_TRIGGER = {
  riskStates: ['atRisk', 'confirmedCompromised'],
  riskLevel: RISK_TRIGGER,
} as const

export interface RiskySignInFlag {
  signInId: string
  trigger: typeof RISK_TRIGGER
  observedRiskLevel: string
  evidence: {
    requestId: string
    timestamp: string
    user: string
    app: string
    ipAddress: string
    location: string
    deviceCompliance: string
    conditionalAccessResult: string
  }
}

export interface RiskyUserFlag {
  userId: string
  user: string
  trigger: typeof RISKY_USER_TRIGGER
  riskState: string
  riskLevel: string
  detections: { id: string; type: string; riskLevel: string; detectedDateTime: string }[]
  signInIds: string[]
}

/* A category whose sources were not all collected is not evaluated: it has no flags, so no count, never a quiet 0. */
export type RiskCategory<F> = { evaluated: true; flags: F[] } | { evaluated: false; missingSources: SourceId[] }

export interface RiskFlags {
  riskySignIns: RiskCategory<RiskySignInFlag>
  riskyUsers: RiskCategory<RiskyUserFlag>
}

export const SOURCES = [
  'signIns.interactiveUser',
  'signIns.nonInteractiveUser',
  'signIns.servicePrincipal',
  'signIns.managedIdentity',
  /* Identity Protection as one source: the day's risk detections and the risky users, collected together. */
  'identityProtection.riskDetections',
] as const
export type SourceId = (typeof SOURCES)[number]

export const SOURCE_LABELS: Readonly<Record<SourceId, string>> = {
  'signIns.interactiveUser': 'Interactive user sign-ins',
  'signIns.nonInteractiveUser': 'Non-interactive user sign-ins',
  'signIns.servicePrincipal': 'Service principal sign-ins',
  'signIns.managedIdentity': 'Managed identity sign-ins',
  'identityProtection.riskDetections': 'Identity Protection risk data',
}

export interface ReportWindow {
  /* Inclusive. */
  start: string
  /* Exclusive. */
  end: string
}

export interface Totals {
  total: number
  successful: number
  failed: number
}

export interface PublishedReport {
  reportDate: string
  windowStart: string
  windowEnd: string
  status: 'complete' | 'incomplete'
  missingSources: SourceId[]
  totals: Totals
  /* The Daily report figures (IF-18), computed from signIns before publish and covered by contentHash. */
  figures: DailyFigures
  signIns: SignIn[]
  riskDetections: RiskDetection[]
  riskyUsers: RiskyUser[]
  riskFlags: RiskFlags
  contentHash: string
  publishedAt: string
}

export interface NotGeneratedDay {
  reportDate: string
  missingSources: SourceId[]
  recordedAt: string
}
