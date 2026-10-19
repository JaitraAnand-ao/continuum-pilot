import type {
  Clock,
  MetricDatum,
  MetricSink,
  Page,
  RiskDetection,
  RiskSource,
  SignIn,
  SignInSource,
  SignInType,
  Sleeper,
  WindowQuery,
} from '../src/index.js'

export class FakeClock implements Clock, Sleeper {
  readonly sleeps: number[] = []
  private current: number

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

let sequence = 0

export function signIn(createdDateTime: string, overrides: Partial<SignIn> = {}): SignIn {
  sequence += 1
  return {
    id: `si-${sequence}`,
    createdDateTime,
    signInEventType: 'interactiveUser',
    userId: 'u-1',
    appId: 'app-1',
    status: { errorCode: 0 },
    appliedConditionalAccessPolicies: [{ id: 'ca-1', displayName: 'Require MFA', result: 'success' }],
    deviceDetail: {
      deviceId: 'dev-1',
      operatingSystem: 'Windows',
      isCompliant: true,
      isManaged: true,
      trustType: 'AzureAd',
    },
    ...overrides,
  }
}

export function manySignIns(count: number, day: string): SignIn[] {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  const step = Math.floor(86_400_000 / count)
  const types: SignInType[] = ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity']
  const out: SignIn[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: `bulk-${i}`,
      createdDateTime: new Date(start + i * step).toISOString(),
      signInEventType: types[i % 4] as SignInType,
      userId: `u-${i % 97}`,
      appId: 'app-1',
      status: { errorCode: i % 10 === 0 ? 50126 : 0 },
      appliedConditionalAccessPolicies: [],
      deviceDetail: { deviceId: '', operatingSystem: 'Linux', isCompliant: false, isManaged: false, trustType: '' },
    })
  }
  return out
}

interface FakeOptions {
  pageSize?: number
  throttle?: { atCursor: string | null; retryAfterSeconds: number }
  failAlways?: boolean
  clock?: Clock
}

/** A paged Graph collection: answers in `pageSize` pages and only with items Graph would filter into the window. */
class PagedFake<T extends { createdDateTime?: string; activityDateTime?: string }> {
  readonly calls: { cursor: string | null; at: number }[] = []
  private throttled = false
  private cache: { key: string; matching: T[] } | null = null

  constructor(
    private readonly items: T[],
    private readonly options: FakeOptions,
  ) {}

  async page(query: WindowQuery, cursor: string | null): Promise<Page<T>> {
    this.calls.push({ cursor, at: this.options.clock ? this.options.clock.now().getTime() : 0 })
    if (this.options.failAlways) throw new Error('graph 503')
    const throttle = this.options.throttle
    if (throttle && !this.throttled && throttle.atCursor === cursor) {
      this.throttled = true
      return { kind: 'throttled', retryAfterSeconds: throttle.retryAfterSeconds }
    }
    const key = `${query.start.toISOString()}/${query.end.toISOString()}`
    if (this.cache?.key !== key) {
      const matching = this.items.filter((item) => {
        const at = Date.parse(item.createdDateTime ?? item.activityDateTime ?? '')
        return at >= query.start.getTime() && at < query.end.getTime()
      })
      this.cache = { key, matching }
    }
    const matching = this.cache.matching
    const size = this.options.pageSize ?? 1000
    const offset = cursor === null ? 0 : Number(cursor)
    const next = offset + size < matching.length ? String(offset + size) : null
    return { kind: 'page', items: matching.slice(offset, offset + size), next }
  }
}

export class FakeSignInSource implements SignInSource {
  private readonly fake: PagedFake<SignIn>
  constructor(items: SignIn[], options: FakeOptions = {}) {
    this.fake = new PagedFake(items, options)
  }
  get calls() {
    return this.fake.calls
  }
  /* Arrow properties so a spying Proxy sees only the calls the job makes, not this.fake. */
  fetchSignInsPage = (query: WindowQuery, cursor: string | null): Promise<Page<SignIn>> => {
    return this.fake.page(query, cursor)
  }
}

export class FakeRiskSource implements RiskSource {
  private readonly fake: PagedFake<RiskDetection>
  constructor(items: RiskDetection[], options: FakeOptions = {}) {
    this.fake = new PagedFake(items, options)
  }
  get calls() {
    return this.fake.calls
  }
  fetchRiskDetectionsPage = (query: WindowQuery, cursor: string | null): Promise<Page<RiskDetection>> => {
    return this.fake.page(query, cursor)
  }
}

export class RecordingMetrics implements MetricSink {
  readonly data: MetricDatum[] = []
  async put(datum: MetricDatum): Promise<void> {
    this.data.push(datum)
  }
}
