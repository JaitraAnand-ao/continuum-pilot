import {
  GraphThrottledError,
  SIGN_IN_TYPES,
  type Clock,
  type GraphReadPort,
  type Metric,
  type MetricsPort,
  type NotGeneratedDay,
  type Page,
  type PublishResult,
  type PublishedReport,
  type ReportStore,
  type ReportWindow,
  type RiskDetection,
  type RiskyUser,
  type SignIn,
  type SignInType,
} from '../src/index.js'

/* A clock whose time only moves when the code under test sleeps or the test advances it. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = []
  private ms: number

  constructor(iso: string) {
    this.ms = Date.parse(iso)
  }

  now(): Date {
    return new Date(this.ms)
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    this.ms += ms
  }

  set(iso: string): void {
    this.ms = Date.parse(iso)
  }
}

export function signIn(overrides: Partial<SignIn> & { id: string }): SignIn {
  return {
    createdDateTime: '2026-10-11T12:00:00.000Z',
    signInEventType: 'interactiveUser',
    errorCode: 0,
    appId: 'app-exchange',
    appDisplayName: 'Exchange Online',
    conditionalAccessPolicies: [{ id: 'ca-1', displayName: 'Require MFA', result: 'success' }],
    deviceDetail: {
      deviceId: 'dev-1',
      operatingSystem: 'Windows',
      browser: 'Edge',
      isCompliant: true,
      isManaged: true,
    },
    correlationId: `req-${overrides.id}`,
    userId: 'u-default',
    userPrincipalName: 'default@contoso.example',
    ipAddress: '203.0.113.10',
    location: { city: 'Dublin', state: 'Leinster', countryOrRegion: 'IE' },
    riskLevelAggregated: 'none',
    conditionalAccessStatus: 'success',
    ...overrides,
  }
}

export function riskDetection(overrides: Partial<RiskDetection> & { id: string }): RiskDetection {
  return {
    detectedDateTime: '2026-10-11T12:00:00.000Z',
    riskLevel: 'medium',
    riskEventType: 'unfamiliarFeatures',
    userId: 'u-default',
    ...overrides,
  }
}

export function riskyUser(overrides: Partial<RiskyUser> & { id: string }): RiskyUser {
  return {
    userPrincipalName: `${overrides.id}@contoso.example`,
    riskState: 'atRisk',
    riskLevel: 'high',
    riskLastUpdatedDateTime: '2026-10-11T12:00:00.000Z',
    ...overrides,
  }
}

type Failure = 'throttle' | 'error'

/* Graph as the port sees it: pages of a fixed size, optional scripted failures per call. */
export class FakeGraph implements GraphReadPort {
  readonly calls: string[] = []
  readonly signInFailures = new Map<string, Failure[]>()
  /* Identity Protection as a whole: both the risk detection and the risky user endpoints fail. */
  failRisk: 'always' | 'never' = 'never'
  failRiskyUsers: 'always' | 'never' = 'never'
  failSignIns: 'always' | 'never' = 'never'
  retryAfterSeconds = 5

  private readonly byType = new Map<SignInType, SignIn[]>()

  constructor(
    signIns: SignIn[] = [],
    private readonly risks: RiskDetection[] = [],
    private readonly pageSize = 1000,
    private readonly riskyUsers: RiskyUser[] = [],
  ) {
    for (const type of SIGN_IN_TYPES) this.byType.set(type, [])
    for (const s of signIns) this.byType.get(s.signInEventType)!.push(s)
  }

  async signInsPage(query: {
    type: SignInType
    window: ReportWindow
    cursor: string | undefined
  }): Promise<Page<SignIn>> {
    const key = `signIns:${query.type}:${query.cursor ?? '0'}`
    this.calls.push(key)
    if (this.failSignIns === 'always') throw new Error('Graph 503')
    const scripted = this.signInFailures.get(key)?.shift()
    if (scripted === 'throttle') throw new GraphThrottledError(this.retryAfterSeconds)
    if (scripted === 'error') throw new Error('Graph 503')
    const start = Date.parse(query.window.start)
    const end = Date.parse(query.window.end)
    /* The fake is deliberately lax at the end boundary (le, not lt) so the worker's own boundary rule is tested. */
    const matching = this.byType
      .get(query.type)!
      .filter((s) => Date.parse(s.createdDateTime) >= start && Date.parse(s.createdDateTime) <= end)
    return this.page(matching, query.cursor)
  }

  async riskDetectionsPage(query: { window: ReportWindow; cursor: string | undefined }): Promise<Page<RiskDetection>> {
    this.calls.push(`risk:${query.cursor ?? '0'}`)
    if (this.failRisk === 'always') throw new Error('Identity Protection 500')
    return this.page(this.risks, query.cursor)
  }

  async riskyUsersPage(query: { cursor: string | undefined }): Promise<Page<RiskyUser>> {
    this.calls.push(`riskyUsers:${query.cursor ?? '0'}`)
    if (this.failRisk === 'always' || this.failRiskyUsers === 'always') throw new Error('Identity Protection 500')
    return this.page(this.riskyUsers, query.cursor)
  }

  private page<T>(items: T[], cursor: string | undefined): Page<T> {
    const offset = cursor === undefined ? 0 : Number(cursor)
    const slice = items.slice(offset, offset + this.pageSize)
    const nextOffset = offset + this.pageSize
    return nextOffset < items.length ? { items: slice, next: String(nextOffset) } : { items: slice }
  }
}

export class MemoryStore implements ReportStore {
  readonly reports = new Map<string, PublishedReport>()
  readonly notGenerated = new Map<string, NotGeneratedDay>()

  async findReport(reportDate: string): Promise<PublishedReport | undefined> {
    return this.reports.get(reportDate)
  }

  async findNotGenerated(reportDate: string): Promise<NotGeneratedDay | undefined> {
    return this.notGenerated.get(reportDate)
  }

  async publish(report: PublishedReport): Promise<PublishResult> {
    const existing = this.reports.get(report.reportDate)
    if (existing) return { created: false, report: structuredClone(existing) }
    this.reports.set(report.reportDate, structuredClone(report))
    return { created: true, report: structuredClone(report) }
  }

  async recordNotGenerated(day: NotGeneratedDay): Promise<void> {
    this.notGenerated.set(day.reportDate, day)
  }
}

export class RecordingMetrics implements MetricsPort {
  readonly emitted: Metric[] = []

  async put(metric: Metric): Promise<void> {
    this.emitted.push(metric)
  }
}
