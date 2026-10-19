/* Test doubles for the report-worker ports: a settable clock whose sleeps advance it,
 * a scriptable Graph reader that pages and throttles like Graph, and an in-memory store
 * that keeps one published report per date. */
import type {
  Clock,
  GraphPage,
  GraphReader,
  MetricDatum,
  MetricsSink,
  NotGeneratedRecord,
  PublishedReport,
  ReportStore,
  RiskRecord,
  SignInEventType,
  SignInRecord,
  Sleeper,
} from '../../src/index.js'

export class FakeClock implements Clock, Sleeper {
  private current: number
  readonly sleeps: number[] = []

  constructor(iso: string) {
    this.current = Date.parse(iso)
  }

  now(): Date {
    return new Date(this.current)
  }

  set(iso: string): void {
    this.current = Date.parse(iso)
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    this.current += ms
  }
}

export function signIn(
  id: string,
  createdDateTime: string,
  signInEventType: SignInEventType,
  errorCode = 0,
): SignInRecord {
  return {
    id,
    createdDateTime,
    signInEventType,
    status: { errorCode },
    appliedConditionalAccessPolicies: [{ id: 'ca-1', displayName: 'Require MFA', result: 'success' }],
    deviceDetail: { deviceId: `dev-${id}`, operatingSystem: 'Windows', browser: 'Edge', isCompliant: true },
  }
}

export interface GraphRequest {
  collection: string
  index: number
  at: string
}

/* Graph-like reader. Each collection is served in pages of pageSize; `throttle` maps
 * "collection:pageIndex" to a Retry-After answered once; `fail` decides whether a request
 * fails. It returns every stored sign-in regardless of the window, so the boundary rule
 * under test is the worker's own, not the fake's. */
export class FakeGraph implements GraphReader {
  readonly requests: GraphRequest[] = []
  pageSize = 100
  throttle = new Map<string, number>()
  fail: (collection: string, index: number) => boolean = () => false
  throwOn: (collection: string) => boolean = () => false
  readonly signIns = new Map<SignInEventType, SignInRecord[]>([
    ['interactiveUser', []],
    ['nonInteractiveUser', []],
    ['servicePrincipal', []],
    ['managedIdentity', []],
  ])
  riskDetections: RiskRecord[] = []
  riskyUsers: RiskRecord[] = []

  constructor(private readonly clock: Clock) {}

  addSignIns(...records: SignInRecord[]): void {
    for (const record of records) this.signIns.get(record.signInEventType)?.push(record)
  }

  private serve<T>(collection: string, all: readonly T[], cursor: string | null): GraphPage<T> {
    const index = cursor === null ? 0 : Number(cursor)
    this.requests.push({ collection, index, at: this.clock.now().toISOString() })
    if (this.throwOn(collection)) throw new Error('socket hang up')
    if (this.fail(collection, index)) return { kind: 'failed', reason: 'HTTP 503' }
    const key = `${collection}:${index}`
    const retryAfterSeconds = this.throttle.get(key)
    if (retryAfterSeconds !== undefined) {
      this.throttle.delete(key)
      return { kind: 'throttled', retryAfterSeconds }
    }
    const start = index * this.pageSize
    const items = all.slice(start, start + this.pageSize)
    const nextCursor = start + this.pageSize < all.length ? String(index + 1) : null
    return { kind: 'page', items, nextCursor }
  }

  async readSignInPage(request: { eventType: SignInEventType; cursor: string | null }) {
    return this.serve(`signIns/${request.eventType}`, this.signIns.get(request.eventType) ?? [], request.cursor)
  }

  async readRiskDetectionPage(request: { cursor: string | null }) {
    return this.serve('riskDetections', this.riskDetections, request.cursor)
  }

  async readRiskyUserPage(request: { cursor: string | null }) {
    return this.serve('riskyUsers', this.riskyUsers, request.cursor)
  }
}

export class MemoryStore implements ReportStore {
  readonly published = new Map<string, PublishedReport>()
  readonly notGenerated = new Map<string, NotGeneratedRecord>()
  publishCalls = 0

  async findPublished(reportDate: string) {
    return this.published.get(reportDate) ?? null
  }

  async publish(report: PublishedReport) {
    this.publishCalls += 1
    const existing = this.published.get(report.reportDate)
    if (existing) return { created: false, report: existing }
    this.published.set(report.reportDate, structuredClone(report))
    this.notGenerated.delete(report.reportDate)
    return { created: true, report }
  }

  async recordNotGenerated(record: NotGeneratedRecord) {
    this.notGenerated.set(record.reportDate, structuredClone(record))
  }
}

export class MemoryMetrics implements MetricsSink {
  readonly data: MetricDatum[] = []

  async put(datum: MetricDatum) {
    this.data.push(datum)
  }

  named(name: string): MetricDatum[] {
    return this.data.filter((d) => d.name === name)
  }
}
