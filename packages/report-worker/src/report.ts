/* Snapshot-then-compute: the rules that turn what was collected into a report's content.
 * Pure apart from hashing; the figures are always computed from the stored snapshot. */
import { createHash } from 'node:crypto'
import type { Collected } from './collect.js'
import {
  REPORT_SOURCES,
  SIGN_IN_EVENT_TYPES,
  SOURCE_LABELS,
  type JsonValue,
  type ReportSource,
  type RiskRecord,
  type SignInEventType,
  type SignInRecord,
} from './signins.js'
import { parseInstant, type ReportWindow } from './window.js'

export interface IdentityProtectionData {
  riskDetections: RiskRecord[]
  riskyUsers: RiskRecord[]
}

export type SourceResults = { [T in SignInEventType]: Collected<SignInRecord[]> } & {
  identityProtection: Collected<IdentityProtectionData>
}

export type Completeness = 'complete' | 'incomplete'

export type Outcome =
  | { kind: 'publish'; completeness: Completeness; missingSources: ReportSource[] }
  | { kind: 'not-generated'; missingSources: ReportSource[] }

export interface Counts {
  total: number
  successful: number
  failed: number
}

export interface ReportTotals extends Counts {
  byEventType: Record<SignInEventType, Counts>
}

export interface ReportContent {
  reportDate: string
  window: { start: string; end: string }
  completeness: Completeness
  missingSources: ReportSource[]
  missingSourceLabels: string[]
  totals: ReportTotals
  snapshot: {
    signIns: SignInRecord[]
    riskDetections: RiskRecord[]
    riskyUsers: RiskRecord[]
  }
}

function zero(): Counts {
  return { total: 0, successful: 0, failed: 0 }
}

function count(counts: Counts, succeeded: boolean): void {
  counts.total += 1
  if (succeeded) counts.successful += 1
  else counts.failed += 1
}

/* Error code 0 is a successful sign-in; every other code is a failure. */
export function computeTotals(signIns: readonly SignInRecord[]): ReportTotals {
  const totals: ReportTotals = {
    ...zero(),
    byEventType: {
      interactiveUser: zero(),
      nonInteractiveUser: zero(),
      servicePrincipal: zero(),
      managedIdentity: zero(),
    },
  }
  for (const signIn of signIns) {
    const succeeded = signIn.status.errorCode === 0
    count(totals, succeeded)
    count(totals.byEventType[signIn.signInEventType], succeeded)
  }
  return totals
}

/* A day with no sign-in type collected is not generated; any other gap makes the report
 * incomplete and names what is missing. It is never complete with a source missing. */
export function decideOutcome(results: SourceResults): Outcome {
  const missingSources = REPORT_SOURCES.filter((source) => !results[source].ok)
  if (SIGN_IN_EVENT_TYPES.every((type) => !results[type].ok)) return { kind: 'not-generated', missingSources }
  return { kind: 'publish', completeness: missingSources.length === 0 ? 'complete' : 'incomplete', missingSources }
}

export function sourceLabels(sources: readonly ReportSource[]): string[] {
  return sources.map((source) => SOURCE_LABELS[source])
}

/* Only sign-ins inside [start, end), the same edges as isWithinWindow, each id once,
 * ordered by time and then by id, which is unique. */
function snapshotSignIns(window: ReportWindow, results: SourceResults): SignInRecord[] {
  const byId = new Map<string, { at: number; signIn: SignInRecord }>()
  const start = Date.parse(window.start)
  const end = Date.parse(window.end)
  for (const type of SIGN_IN_EVENT_TYPES) {
    const result = results[type]
    if (!result.ok) continue
    for (const signIn of result.items) {
      if (byId.has(signIn.id)) continue
      const at = parseInstant(signIn.createdDateTime)
      if (at >= start && at < end) byId.set(signIn.id, { at, signIn })
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.at - b.at || (a.signIn.id < b.signIn.id ? -1 : 1))
    .map((entry) => entry.signIn)
}

export function buildReportContent(window: ReportWindow, results: SourceResults, outcome: Outcome): ReportContent {
  if (outcome.kind !== 'publish') throw new Error(`no report content for a day that is ${outcome.kind}`)
  const signIns = snapshotSignIns(window, results)
  const protection = results.identityProtection.ok
    ? results.identityProtection.items
    : { riskDetections: [], riskyUsers: [] }
  return {
    reportDate: window.reportDate,
    window: { start: window.start, end: window.end },
    completeness: outcome.completeness,
    missingSources: outcome.missingSources,
    missingSourceLabels: sourceLabels(outcome.missingSources),
    totals: computeTotals(signIns),
    snapshot: { signIns, riskDetections: protection.riskDetections, riskyUsers: protection.riskyUsers },
  }
}

/* JSON with every object's keys in sorted order. */
function canonical(value: JsonValue): string {
  return JSON.stringify(value, (_key, field: JsonValue) => {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) return field
    const sorted: { [key: string]: JsonValue } = {}
    for (const key of Object.keys(field).sort()) sorted[key] = field[key] as JsonValue
    return sorted
  })
}

/* SHA-256 over the content with keys sorted, so the hash depends on what the report says,
 * not on property order. publishedAt is outside the content and outside the hash. */
export function contentHash(content: ReportContent): string {
  return createHash('sha256')
    .update(canonical(content as unknown as JsonValue))
    .digest('hex')
}
