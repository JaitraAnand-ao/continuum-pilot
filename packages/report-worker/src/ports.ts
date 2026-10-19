import type { RiskDetection, SignIn, SignInType } from './sign-in.js'

export interface ReportWindow {
  /* Inclusive. */
  start: Date
  /* Exclusive. */
  end: Date
}

export interface Page<T> {
  items: T[]
  /* Opaque to the worker; absent on the last page. */
  nextCursor?: string
}

/* IF-13: read-only sign-in collection, one page per call. Implemented by graph-adapter. */
export interface SignInSource {
  fetchSignInPage(type: SignInType, window: ReportWindow, cursor?: string): Promise<Page<SignIn>>
}

/* IF-14: read-only Identity Protection risk detections, one page per call. Implemented by graph-adapter. */
export interface RiskSource {
  fetchRiskDetectionPage(window: ReportWindow, cursor?: string): Promise<Page<RiskDetection>>
}

/* Graph answered 429; the same page may be asked for again after retryAfterSeconds. */
export class GraphThrottledError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Graph throttled the request; retry after ${retryAfterSeconds}s`)
    this.name = 'GraphThrottledError'
  }
}

export interface Totals {
  total: number
  successful: number
  failed: number
}

export interface PublishedReport {
  id: string
  reportDate: string
  windowStart: string
  windowEnd: string
  complete: boolean
  missingSources: string[]
  totals: Totals
  contentHash: string
  publishedAt: string
}

export type ReportDraft = Omit<PublishedReport, 'id' | 'publishedAt'> & {
  signIns: SignIn[]
  riskDetections: RiskDetection[]
}

export interface ReportStore {
  findPublished(reportDate: string): Promise<PublishedReport | undefined>
  /* Atomic and idempotent per report date: when one is already published, it is returned untouched. */
  publish(draft: ReportDraft, publishedAt: Date): Promise<{ report: PublishedReport; created: boolean }>
  recordNotGenerated(reportDate: string, missingSources: string[], recordedAt: Date): Promise<void>
}

export interface MetricsSink {
  emit(name: string, value: number, properties?: Record<string, string>): void
}
