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
  isCompliant: boolean
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
}

export interface RiskDetection {
  id: string
  detectedDateTime: string
  riskLevel: string
  riskEventType: string
}

export const SOURCES = [
  'signIns.interactiveUser',
  'signIns.nonInteractiveUser',
  'signIns.servicePrincipal',
  'signIns.managedIdentity',
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
  contentHash: string
  publishedAt: string
}

export interface NotGeneratedDay {
  reportDate: string
  missingSources: SourceId[]
  recordedAt: string
}
