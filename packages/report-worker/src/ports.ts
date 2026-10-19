/* Ports the job depends on. Graph is reached only through SignInSource (IF-13) and
 * RiskSource (IF-14), both implemented by the graph-adapter; both are read-only. */

export type SignInType = 'interactiveUser' | 'nonInteractiveUser' | 'servicePrincipal' | 'managedIdentity'

export const SIGN_IN_TYPES: readonly SignInType[] = [
  'interactiveUser',
  'nonInteractiveUser',
  'servicePrincipal',
  'managedIdentity',
]

export interface ConditionalAccessPolicyResult {
  readonly id: string
  readonly displayName: string
  readonly result: string
}

export interface DeviceDetail {
  readonly deviceId: string
  readonly operatingSystem: string
  readonly isCompliant: boolean
  readonly isManaged: boolean
  readonly trustType: string
}

export interface SignIn {
  readonly id: string
  readonly createdDateTime: string
  readonly signInEventType: SignInType
  readonly userId: string
  readonly appId: string
  readonly status: { readonly errorCode: number }
  readonly appliedConditionalAccessPolicies: readonly ConditionalAccessPolicyResult[]
  readonly deviceDetail: DeviceDetail
}

export interface RiskDetection {
  readonly id: string
  readonly activityDateTime: string
  readonly riskEventType: string
  readonly riskLevel: string
  readonly userId: string
}

export interface WindowQuery {
  readonly start: Date
  readonly end: Date
}

/** One Graph page, or a 429 carrying its Retry-After. Any other failure is thrown. */
export type Page<T> =
  | { readonly kind: 'page'; readonly items: readonly T[]; readonly next: string | null }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds: number }

/** IF-13: auditLogs/signIns for all four sign-in event types. */
export interface SignInSource {
  fetchSignInsPage(query: WindowQuery, cursor: string | null): Promise<Page<SignIn>>
}

/** IF-14: Identity Protection riskDetections. */
export interface RiskSource {
  fetchRiskDetectionsPage(query: WindowQuery, cursor: string | null): Promise<Page<RiskDetection>>
}

export interface Clock {
  now(): Date
}

export interface Sleeper {
  sleep(ms: number): Promise<void>
}

export interface MetricDatum {
  readonly namespace: string
  readonly name: string
  readonly value: number
  readonly dimensions: Readonly<Record<string, string>>
}

export interface MetricSink {
  put(datum: MetricDatum): Promise<void>
}

export interface Tracer {
  inSpan<T>(name: string, attributes: Record<string, string>, fn: () => Promise<T>): Promise<T>
}
