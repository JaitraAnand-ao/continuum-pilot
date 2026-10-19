import type {
  Clock,
  MetricsSink,
  Page,
  PublishedReport,
  ReportDraft,
  ReportStore,
  ReportWindow,
  RiskDetection,
  RiskSource,
  SignIn,
  SignInSource,
  SignInType,
  Sleeper,
} from '../../src/index.js'

export class FakeClock implements Clock {
  private at: number
  constructor(iso: string) {
    this.at = new Date(iso).getTime()
  }
  now() {
    return new Date(this.at)
  }
  set(iso: string) {
    this.at = new Date(iso).getTime()
  }
  advance(milliseconds: number) {
    this.at += milliseconds
  }
}

/* Sleeping moves the fake clock forward, so retry loops reach their deadline without real waiting. */
export class FakeSleeper implements Sleeper {
  readonly sleeps: number[] = []
  constructor(private readonly clock: FakeClock) {}
  async sleep(milliseconds: number) {
    this.sleeps.push(milliseconds)
    this.clock.advance(milliseconds)
  }
}

export class RecordingMetrics implements MetricsSink {
  readonly emitted: { name: string; value: number; properties: Record<string, string> }[] = []
  emit(name: string, value: number, properties: Record<string, string> = {}) {
    this.emitted.push({ name, value, properties })
  }
  last(name: string) {
    return this.emitted.filter((metric) => metric.name === name).at(-1)
  }
}

export interface GraphCall {
  source: SignInType | 'risk'
  cursor: string | undefined
  window: ReportWindow
  at: number
}

/* A scripted stand-in for the graph-adapter ports: serves fixed data in pages and fails on demand. */
export class ScriptedGraph implements SignInSource, RiskSource {
  readonly calls: GraphCall[] = []
  failWith: (call: GraphCall, attempt: number) => Error | undefined = () => undefined
  private attempts = 0
  private readonly byType = new Map<SignInType, SignIn[]>()

  constructor(
    private readonly clock: FakeClock,
    private readonly data: { signIns?: SignIn[]; risk?: RiskDetection[]; pageSize?: number },
  ) {
    for (const signIn of data.signIns ?? []) {
      if (!this.byType.has(signIn.type)) this.byType.set(signIn.type, [])
      this.byType.get(signIn.type)?.push(signIn)
    }
  }

  private serve<T>(call: GraphCall, items: T[]): Page<T> {
    this.calls.push(call)
    const failure = this.failWith(call, this.attempts++)
    if (failure) throw failure
    const pageSize = this.data.pageSize ?? 1000
    const offset = call.cursor === undefined ? 0 : Number(call.cursor)
    const next = offset + pageSize
    return {
      items: items.slice(offset, next),
      ...(next < items.length ? { nextCursor: String(next) } : {}),
    }
  }

  async fetchSignInPage(type: SignInType, window: ReportWindow, cursor?: string) {
    const items = this.byType.get(type) ?? []
    return this.serve({ source: type, cursor, window, at: this.clock.now().getTime() }, items)
  }

  async fetchRiskDetectionPage(window: ReportWindow, cursor?: string) {
    return this.serve({ source: 'risk', cursor, window, at: this.clock.now().getTime() }, this.data.risk ?? [])
  }
}

export class InMemoryReportStore implements ReportStore {
  private readonly reports = new Map<string, { report: PublishedReport; draft: ReportDraft }>()
  readonly notGenerated = new Map<string, string[]>()
  private nextId = 1

  async findPublished(reportDate: string) {
    return this.reports.get(reportDate)?.report
  }
  async publish(draft: ReportDraft, publishedAt: Date) {
    const existing = this.reports.get(draft.reportDate)
    if (existing) return { report: existing.report, created: false }
    const { reportDate, windowStart, windowEnd, complete, missingSources, totals, contentHash } = draft
    const report = {
      reportDate,
      windowStart,
      windowEnd,
      complete,
      missingSources,
      totals,
      contentHash,
      id: String(this.nextId++),
      publishedAt: publishedAt.toISOString(),
    }
    this.reports.set(draft.reportDate, { report, draft: structuredClone(draft) })
    return { report, created: true }
  }
  async recordNotGenerated(reportDate: string, missingSources: string[]) {
    this.notGenerated.set(reportDate, missingSources)
  }
  listPublished() {
    return [...this.reports.values()].map((entry) => entry.report)
  }
  snapshot(reportDate: string) {
    return this.reports.get(reportDate)?.draft
  }
}

let sequence = 0

export function signIn(overrides: Partial<SignIn> = {}): SignIn {
  sequence += 1
  return {
    id: `sign-in-${String(sequence).padStart(7, '0')}`,
    createdAt: '2026-10-11T12:00:00.000Z',
    type: 'interactiveUser',
    errorCode: 0,
    conditionalAccessPolicies: [{ policyId: 'policy-mfa', displayName: 'Require MFA', result: 'success' }],
    device: { deviceId: 'device-1', operatingSystem: 'Windows', browser: 'Edge', isCompliant: true, isManaged: true },
    ...overrides,
  }
}

export function riskDetection(overrides: Partial<RiskDetection> = {}): RiskDetection {
  sequence += 1
  return {
    id: `risk-${sequence}`,
    detectedAt: '2026-10-11T09:00:00.000Z',
    riskEventType: 'unfamiliarFeatures',
    riskLevel: 'medium',
    ...overrides,
  }
}
