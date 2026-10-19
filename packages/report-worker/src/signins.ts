/* What the worker reads from Microsoft Graph, and the read-only port it reads through.
 * The graph-adapter implements GraphReader; nothing here speaks HTTP. */
import type { ReportWindow } from './window.js'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export const SIGN_IN_EVENT_TYPES = [
  'interactiveUser',
  'nonInteractiveUser',
  'servicePrincipal',
  'managedIdentity',
] as const
export type SignInEventType = (typeof SIGN_IN_EVENT_TYPES)[number]

export interface ConditionalAccessPolicyResult {
  id: string
  displayName: string
  result: string
}

export interface SignInRecord {
  id: string
  createdDateTime: string
  signInEventType: SignInEventType
  status: { errorCode: number; failureReason?: string }
  appliedConditionalAccessPolicies: ConditionalAccessPolicyResult[]
  deviceDetail: { [field: string]: string | boolean | null }
}

export interface RiskRecord {
  id: string
  [field: string]: JsonValue
}

export type GraphPage<T> =
  | { kind: 'page'; items: T[]; nextCursor: string | null }
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'failed'; reason: string }

/* Read-only by construction: the job's identity holds only the permissions below (AC-8). */
export interface GraphReader {
  readSignInPage(request: {
    eventType: SignInEventType
    window: ReportWindow
    cursor: string | null
  }): Promise<GraphPage<SignInRecord>>
  readRiskDetectionPage(request: { window: ReportWindow; cursor: string | null }): Promise<GraphPage<RiskRecord>>
  readRiskyUserPage(request: { cursor: string | null }): Promise<GraphPage<RiskRecord>>
}

export const REPORT_JOB_GRAPH_PERMISSIONS = [
  'AuditLog.Read.All',
  'IdentityRiskEvent.Read.All',
  'IdentityRiskyUser.Read.All',
  'Policy.Read.All',
] as const

export const REPORT_SOURCES = [...SIGN_IN_EVENT_TYPES, 'identityProtection'] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]

export const SOURCE_LABELS: Record<ReportSource, string> = {
  interactiveUser: 'Interactive user sign-ins',
  nonInteractiveUser: 'Non-interactive user sign-ins',
  servicePrincipal: 'Service principal sign-ins',
  managedIdentity: 'Managed identity sign-ins',
  identityProtection: 'Identity Protection risk data',
}
