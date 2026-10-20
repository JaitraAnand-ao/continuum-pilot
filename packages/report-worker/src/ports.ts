import type {
  NotGeneratedDay,
  PublishedReport,
  ReportWindow,
  RiskDetection,
  RiskyUser,
  SignIn,
  SignInType,
} from './model.js'

export interface Clock {
  now(): Date
  sleep(ms: number): Promise<void>
}

export interface Page<T> {
  items: readonly T[]
  next?: string
}

/* IF-13: the read-only Graph port the graph-adapter implements. It has no method that writes to the tenant. */
export interface GraphReadPort {
  signInsPage(query: { type: SignInType; window: ReportWindow; cursor: string | undefined }): Promise<Page<SignIn>>
  riskDetectionsPage(query: { window: ReportWindow; cursor: string | undefined }): Promise<Page<RiskDetection>>
  /* Risky users carry their current state, not a dated event, so the query has no window. */
  riskyUsersPage(query: { cursor: string | undefined }): Promise<Page<RiskyUser>>
}

/* Raised by the adapter for a 429; any other rejection is a transient failure. */
export class GraphThrottledError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Graph throttled the request; retry after ${retryAfterSeconds}s`)
    this.name = 'GraphThrottledError'
  }
}

/* The application permissions the report job's identity holds — all four read-only (AC-8). */
export const REQUIRED_GRAPH_PERMISSIONS = [
  'AuditLog.Read.All',
  'IdentityRiskEvent.Read.All',
  'IdentityRiskyUser.Read.All',
  'Policy.Read.All',
] as const

export interface PublishResult {
  created: boolean
  /* The report now stored for the date: the one just written, or the one that was already there. */
  report: PublishedReport
}

/* IF-14: report storage. publish writes the report and its snapshot in one statement and never replaces one. */
export interface ReportStore {
  findReport(reportDate: string): Promise<PublishedReport | undefined>
  findNotGenerated(reportDate: string): Promise<NotGeneratedDay | undefined>
  publish(report: PublishedReport): Promise<PublishResult>
  recordNotGenerated(day: NotGeneratedDay): Promise<void>
}

export const METRIC_NAMESPACE = 'SigninReports'

export interface Metric {
  namespace: typeof METRIC_NAMESPACE
  name: 'ReportPublished' | 'ReportNotGenerated' | 'CompleteReportMissing'
  value: number
  dimensions: Record<string, string>
  timestamp: string
}

/* IF-17: metrics for the CloudWatch alarms (CMP-11). */
export interface MetricsPort {
  put(metric: Metric): Promise<void>
}
