import { collectPages } from './collect.js'
import { figuresOf } from './figures.js'
import { SIGN_IN_TYPES, type PublishedReport, type RiskDetection, type SignIn, type SourceId } from './model.js'
import { METRIC_NAMESPACE, type Clock, type GraphReadPort, type MetricsPort, type ReportStore } from './ports.js'
import { contentHash, snapshotHashInput, totalsOf } from './snapshot.js'
import { isReportDate, retryDeadline, windowContains, windowFor } from './window.js'

export interface GenerateDeps {
  graph: GraphReadPort
  store: ReportStore
  metrics: MetricsPort
  clock: Clock
}

export type GenerateOutcome =
  | { kind: 'published'; report: PublishedReport }
  | { kind: 'already-published'; report: PublishedReport }
  | { kind: 'not-generated'; missingSources: SourceId[] }

/* Snapshot first, then compute: every figure in the report is derived from the snapshot stored with it. */
export async function generateReport(reportDate: string, deps: GenerateDeps): Promise<GenerateOutcome> {
  if (!isReportDate(reportDate)) throw new Error(`invalid report date: ${JSON.stringify(reportDate)}`)
  const existing = await deps.store.findReport(reportDate)
  if (existing) return { kind: 'already-published', report: existing }

  const window = windowFor(reportDate)
  const options = { clock: deps.clock, deadline: retryDeadline(reportDate) }
  const missingSources: SourceId[] = []
  const signIns: SignIn[] = []
  for (const type of SIGN_IN_TYPES) {
    const result = await collectPages((cursor) => deps.graph.signInsPage({ type, window, cursor }), options)
    if (result.ok) signIns.push(...result.items.filter((signIn) => windowContains(window, signIn.createdDateTime)))
    else missingSources.push(`signIns.${type}`)
  }
  const risk = await collectPages((cursor) => deps.graph.riskDetectionsPage({ window, cursor }), options)
  const riskDetections: RiskDetection[] = risk.ok ? risk.items : []
  if (!risk.ok) missingSources.push('identityProtection.riskDetections')

  const now = deps.clock.now().toISOString()
  if (missingSources.length === SIGN_IN_TYPES.length + 1) {
    await deps.store.recordNotGenerated({ reportDate, missingSources, recordedAt: now })
    await deps.metrics.put({
      namespace: METRIC_NAMESPACE,
      name: 'ReportNotGenerated',
      value: 1,
      dimensions: {},
      timestamp: now,
    })
    return { kind: 'not-generated', missingSources }
  }

  const draft = {
    reportDate,
    windowStart: window.start,
    windowEnd: window.end,
    status: missingSources.length === 0 ? ('complete' as const) : ('incomplete' as const),
    missingSources,
    totals: totalsOf(signIns),
    figures: figuresOf(signIns),
    signIns,
    riskDetections,
  }
  const published = await deps.store.publish({
    ...draft,
    contentHash: contentHash(snapshotHashInput(draft)),
    publishedAt: now,
  })
  if (!published.created) return { kind: 'already-published', report: published.report }
  await deps.metrics.put({
    namespace: METRIC_NAMESPACE,
    name: 'ReportPublished',
    value: 1,
    dimensions: { Status: draft.status },
    timestamp: now,
  })
  return { kind: 'published', report: published.report }
}
