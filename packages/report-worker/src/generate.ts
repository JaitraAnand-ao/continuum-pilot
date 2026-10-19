import { createHash } from 'node:crypto'
import { CollectionFailedError, collectAll } from './collect.js'
import type {
  Clock,
  MetricSink,
  RiskDetection,
  RiskSource,
  SignIn,
  SignInSource,
  SignInType,
  Sleeper,
  Tracer,
} from './ports.js'
import { SIGN_IN_TYPES } from './ports.js'
import { ReportAlreadyPublishedError, type ReportStore, type ReportTotals, type StoredReport } from './store.js'
import { inWindow, retryDeadline, windowFor, type ReportWindow } from './window.js'

export const SIGN_IN_SOURCE = 'Entra sign-in logs'
export const IDENTITY_PROTECTION_SOURCE = 'Identity Protection risk data'

/** The only Graph application permissions the report job's identity holds; all read-only. */
export const GRAPH_PERMISSIONS = [
  'AuditLog.Read.All',
  'IdentityRiskEvent.Read.All',
  'IdentityRiskyUser.Read.All',
  'Policy.Read.All',
] as const

export const METRIC_NAMESPACE = 'SigninReports'
export const METRICS = {
  reportPublished: 'ReportPublished',
  reportIncomplete: 'ReportIncomplete',
  reportNotGenerated: 'ReportNotGenerated',
  completeReportMissing: 'CompleteReportMissing',
} as const

export interface GenerateDeps {
  clock: Clock
  sleeper: Sleeper
  signIns: SignInSource
  risk: RiskSource
  store: ReportStore
  metrics: MetricSink
  tracer?: Tracer
}

export type GenerateOutcome =
  | { readonly outcome: 'published'; readonly report: StoredReport }
  | { readonly outcome: 'unchanged'; readonly report: StoredReport }
  | { readonly outcome: 'not-generated'; readonly reportDate: string; readonly missingSources: string[] }

const noTracer: Tracer = { inSpan: (_name, _attributes, fn) => fn() }

/* Only the fields the report needs cross into the snapshot; anything else Graph adds stays out. */
function toSignIn(raw: SignIn): SignIn {
  return {
    id: raw.id,
    createdDateTime: raw.createdDateTime,
    signInEventType: raw.signInEventType,
    userId: raw.userId,
    appId: raw.appId,
    status: { errorCode: raw.status.errorCode },
    appliedConditionalAccessPolicies: raw.appliedConditionalAccessPolicies.map((policy) => ({
      id: policy.id,
      displayName: policy.displayName,
      result: policy.result,
    })),
    deviceDetail: {
      deviceId: raw.deviceDetail.deviceId,
      operatingSystem: raw.deviceDetail.operatingSystem,
      isCompliant: raw.deviceDetail.isCompliant,
      isManaged: raw.deviceDetail.isManaged,
      trustType: raw.deviceDetail.trustType,
    },
  }
}

function toRiskDetection(raw: RiskDetection): RiskDetection {
  return {
    id: raw.id,
    activityDateTime: raw.activityDateTime,
    riskEventType: raw.riskEventType,
    riskLevel: raw.riskLevel,
    userId: raw.userId,
  }
}

/* Snapshot order is fixed by instant, then id, so the content hash does not depend on paging. */
function inWindowSorted<T extends { id: string }>(
  items: readonly T[],
  window: ReportWindow,
  at: (item: T) => string,
): T[] {
  return items
    .map((item) => ({ item, instant: Date.parse(at(item)) }))
    .filter(({ instant }) => inWindow(window, new Date(instant)))
    .sort((a, b) => a.instant - b.instant || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
    .map(({ item }) => item)
}

export function computeTotals(signIns: readonly SignIn[]): ReportTotals {
  const byType = Object.fromEntries(SIGN_IN_TYPES.map((type) => [type, 0])) as Record<SignInType, number>
  let failed = 0
  for (const signIn of signIns) {
    byType[signIn.signInEventType] += 1
    if (signIn.status.errorCode !== 0) failed += 1
  }
  return { total: signIns.length, successful: signIns.length - failed, failed, byType }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function settle<T>(work: Promise<T[]>): Promise<T[] | null> {
  try {
    return await work
  } catch (problem) {
    if (problem instanceof CollectionFailedError) return null
    throw problem
  }
}

/* The scheduled run retries until 07:00 UTC on D+1; a re-run started later gets its own hour. */
const LATE_RERUN_BUDGET_MS = 3_600_000

async function collect(deps: GenerateDeps, window: ReportWindow) {
  const cutOff = retryDeadline(window.reportDate).getTime()
  const now = deps.clock.now().getTime()
  const deadline = new Date(now < cutOff ? cutOff : now + LATE_RERUN_BUDGET_MS)
  const options = { clock: deps.clock, sleeper: deps.sleeper, deadline }
  const query = { start: window.start, end: window.end }
  const [signIns, risk] = await Promise.all([
    settle(collectAll((cursor) => deps.signIns.fetchSignInsPage(query, cursor), options)),
    settle(collectAll((cursor) => deps.risk.fetchRiskDetectionsPage(query, cursor), options)),
  ])
  return { signIns, risk }
}

/**
 * report.generate for date D: snapshot every sign-in in D's window, compute the figures from
 * that snapshot, and publish once. A date already published is returned as it is.
 */
export function generateReport(deps: GenerateDeps, reportDate: string): Promise<GenerateOutcome> {
  const window = windowFor(reportDate)
  const tracer = deps.tracer ?? noTracer
  return tracer.inSpan('report.generate', { 'report.date': reportDate }, async () => {
    const existing = await deps.store.findPublished(reportDate)
    if (existing) return { outcome: 'unchanged', report: existing }

    const collected = await collect(deps, window)
    const missingSources: string[] = []
    if (collected.signIns === null) missingSources.push(SIGN_IN_SOURCE)
    if (collected.risk === null) missingSources.push(IDENTITY_PROTECTION_SOURCE)
    const dimensions = { reportDate }

    if (collected.signIns === null) {
      await deps.store.recordNotGenerated({
        reportDate,
        recordedAt: deps.clock.now().toISOString(),
        missingSources,
      })
      await deps.metrics.put({ namespace: METRIC_NAMESPACE, name: METRICS.reportNotGenerated, value: 1, dimensions })
      return { outcome: 'not-generated', reportDate, missingSources }
    }

    const signIns = inWindowSorted(collected.signIns, window, (s) => s.createdDateTime).map(toSignIn)
    const riskDetections = inWindowSorted(collected.risk ?? [], window, (r) => r.activityDateTime).map(toRiskDetection)
    const content = {
      reportDate,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      complete: missingSources.length === 0,
      missingSources,
      totals: computeTotals(signIns),
      signIns,
      riskDetections,
    }
    const contentHash = createHash('sha256').update(canonical(content)).digest('hex')

    let report: StoredReport
    try {
      report = await deps.store.publish({ ...content, publishedAt: deps.clock.now().toISOString(), contentHash })
    } catch (problem) {
      const winner = problem instanceof ReportAlreadyPublishedError ? await deps.store.findPublished(reportDate) : null
      if (winner) return { outcome: 'unchanged', report: winner }
      throw problem
    }
    await deps.metrics.put({ namespace: METRIC_NAMESPACE, name: METRICS.reportPublished, value: 1, dimensions })
    if (!report.complete) {
      await deps.metrics.put({ namespace: METRIC_NAMESPACE, name: METRICS.reportIncomplete, value: 1, dimensions })
    }
    return { outcome: 'published', report }
  })
}
