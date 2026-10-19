/* report.generate: collect the day from Graph, snapshot it, publish once (AC-1 to AC-5, AC-7). */
import type { Clock, Sleeper } from './clock.js'
import { collectPages, DEFAULT_RETRY, type Collected, type CollectOptions, type RetryPolicy } from './collect.js'
import {
  METRIC_NAMESPACE,
  REPORT_INCOMPLETE_METRIC,
  REPORT_NOT_GENERATED_METRIC,
  REPORT_PUBLISHED_METRIC,
} from './metrics.js'
import type { MetricsSink, NotGeneratedRecord, PublishedReport, ReportStore } from './ports.js'
import {
  buildReportContent,
  contentHash,
  decideOutcome,
  sourceLabels,
  type IdentityProtectionData,
  type SourceResults,
} from './report.js'
import { SIGN_IN_EVENT_TYPES, type GraphReader, type SignInEventType, type SignInRecord } from './signins.js'
import { collectionDeadline, parseReportDate, reportWindow, type ReportWindow } from './window.js'

export interface ReportJobDeps {
  clock: Clock
  sleeper: Sleeper
  graph: GraphReader
  store: ReportStore
  metrics: MetricsSink
  retry?: RetryPolicy
}

export type ReportGenerateResult =
  | { status: 'published' | 'already-published'; report: PublishedReport }
  | { status: 'not-generated'; record: NotGeneratedRecord }

async function collectIdentityProtection(
  graph: GraphReader,
  window: ReportWindow,
  options: CollectOptions,
): Promise<Collected<IdentityProtectionData>> {
  const [riskDetections, riskyUsers] = await Promise.all([
    collectPages((cursor) => graph.readRiskDetectionPage({ window, cursor }), options),
    collectPages((cursor) => graph.readRiskyUserPage({ cursor }), options),
  ])
  if (!riskDetections.ok) return riskDetections
  if (!riskyUsers.ok) return riskyUsers
  return { ok: true, items: { riskDetections: riskDetections.items, riskyUsers: riskyUsers.items } }
}

/* Every source is collected side by side against the one 07:00 UTC deadline, so a source
 * that keeps failing does not starve the others of retry time. */
async function collectSources(graph: GraphReader, window: ReportWindow, options: CollectOptions) {
  const [signIns, identityProtection] = await Promise.all([
    Promise.all(
      SIGN_IN_EVENT_TYPES.map((eventType) =>
        collectPages((cursor) => graph.readSignInPage({ eventType, window, cursor }), options),
      ),
    ),
    collectIdentityProtection(graph, window, options),
  ])
  const byType = Object.fromEntries(SIGN_IN_EVENT_TYPES.map((type, index) => [type, signIns[index]])) as {
    [T in SignInEventType]: Collected<SignInRecord[]>
  }
  return { ...byType, identityProtection } satisfies SourceResults
}

export async function generateReport(reportDate: string, deps: ReportJobDeps): Promise<ReportGenerateResult> {
  const { clock, sleeper, graph, store, metrics } = deps
  const window = reportWindow(parseReportDate(reportDate))

  /* AC-4: a published report is final; a re-run neither reads Graph nor writes. */
  const existing = await store.findPublished(reportDate)
  if (existing) return { status: 'already-published', report: existing }

  const options = {
    clock,
    sleeper,
    deadline: collectionDeadline(reportDate, clock.now()),
    retry: deps.retry ?? DEFAULT_RETRY,
  }
  const results = await collectSources(graph, window, options)
  const outcome = decideOutcome(results)

  if (outcome.kind === 'not-generated') {
    const record: NotGeneratedRecord = {
      reportDate,
      status: 'not-generated',
      missingSources: outcome.missingSources,
      missingSourceLabels: sourceLabels(outcome.missingSources),
      recordedAt: clock.now().toISOString(),
    }
    await store.recordNotGenerated(record)
    await metrics.put({ namespace: METRIC_NAMESPACE, name: REPORT_NOT_GENERATED_METRIC, value: 1, unit: 'Count' })
    return { status: 'not-generated', record }
  }

  const content = buildReportContent(window, results, outcome)
  const { created, report } = await store.publish({
    ...content,
    contentHash: contentHash(content),
    publishedAt: clock.now().toISOString(),
  })
  if (!created) return { status: 'already-published', report }
  await metrics.put({ namespace: METRIC_NAMESPACE, name: REPORT_PUBLISHED_METRIC, value: 1, unit: 'Count' })
  await metrics.put({
    namespace: METRIC_NAMESPACE,
    name: REPORT_INCOMPLETE_METRIC,
    value: report.completeness === 'incomplete' ? 1 : 0,
    unit: 'Count',
  })
  return { status: 'published', report }
}
