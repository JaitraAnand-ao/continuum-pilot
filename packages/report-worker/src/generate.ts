import type { Clock, Sleeper } from './clock.js'
import { collectAllPages } from './collect.js'
import { contentHash } from './content-hash.js'
import { REPORT_COMPLETE, SIGN_INS_COLLECTED } from './metrics.js'
import type { MetricsSink, PublishedReport, ReportStore, RiskSource, SignInSource } from './ports.js'
import {
  assessCompleteness,
  isInWindow,
  isReportable,
  parseReportDate,
  reportWindow,
  retryDeadline,
  totalsOf,
} from './rules.js'
import { SIGN_IN_TYPES, SOURCE_NAMES, type SignIn } from './sign-in.js'

export interface GenerateDeps {
  clock: Clock
  sleeper: Sleeper
  signIns: SignInSource
  risk: RiskSource
  store: ReportStore
  metrics: MetricsSink
}

export type GenerateOutcome =
  | { kind: 'published'; report: PublishedReport; created: boolean }
  | { kind: 'already-published'; report: PublishedReport }
  | { kind: 'not-generated'; missingSources: string[] }

/* report.generate (IF-15): snapshot the day, then compute from the snapshot, then publish once. */
export async function generateReport(reportDate: string, deps: GenerateDeps): Promise<GenerateOutcome> {
  const date = parseReportDate(reportDate)
  const { clock, sleeper, store, metrics } = deps
  if (!isReportable(date, clock.now())) throw new Error(`the day ${date} is not over yet`)

  const existing = await store.findPublished(date)
  if (existing) {
    metrics.emit(REPORT_COMPLETE, existing.complete ? 1 : 0, { reportDate: date })
    return { kind: 'already-published', report: existing }
  }

  const window = reportWindow(date)
  const deadline = retryDeadline(date)
  const [signInResults, riskResult] = await Promise.all([
    Promise.all(
      SIGN_IN_TYPES.map((type) =>
        collectAllPages((cursor) => deps.signIns.fetchSignInPage(type, window, cursor), deadline, clock, sleeper),
      ),
    ),
    collectAllPages((cursor) => deps.risk.fetchRiskDetectionPage(window, cursor), deadline, clock, sleeper),
  ])

  const missingSources: string[] = []
  const collected = new Map<string, SignIn>()
  signInResults.forEach((result, index) => {
    const type = SIGN_IN_TYPES[index] as (typeof SIGN_IN_TYPES)[number]
    if (!result.ok) return void missingSources.push(SOURCE_NAMES[type])
    /* Graph's filter is not trusted with the boundary instants, and a repeated page must not count twice. */
    for (const signIn of result.items) if (isInWindow(signIn.createdAt, window)) collected.set(signIn.id, signIn)
  })
  if (!riskResult.ok) missingSources.push(SOURCE_NAMES.identityProtection)

  const completeness = assessCompleteness(
    signInResults.filter((result) => !result.ok).length,
    SIGN_IN_TYPES.length,
    !riskResult.ok,
  )
  if (completeness === 'not-generated') {
    await store.recordNotGenerated(date, missingSources, clock.now())
    metrics.emit(REPORT_COMPLETE, 0, { reportDate: date })
    return { kind: 'not-generated', missingSources }
  }

  const signIns = [...collected.values()]
  const riskDetections = riskResult.ok ? riskResult.items.filter((risk) => isInWindow(risk.detectedAt, window)) : []
  const content = {
    reportDate: date,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    complete: completeness === 'complete',
    missingSources,
    totals: totalsOf(signIns),
    signIns,
    riskDetections,
  }
  const { report, created } = await store.publish({ ...content, contentHash: contentHash(content) }, clock.now())
  metrics.emit(SIGN_INS_COLLECTED, report.totals.total, { reportDate: date })
  metrics.emit(REPORT_COMPLETE, report.complete ? 1 : 0, { reportDate: date })
  return { kind: 'published', report, created }
}
