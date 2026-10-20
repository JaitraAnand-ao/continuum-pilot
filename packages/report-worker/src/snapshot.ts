import { createHash } from 'node:crypto'
import type { PublishedReport, SignIn, Totals } from './model.js'

export function totalsOf(signIns: readonly SignIn[]): Totals {
  const successful = signIns.filter((signIn) => signIn.errorCode === 0).length
  return { total: signIns.length, successful, failed: signIns.length - successful }
}

/* Everything the hash covers: the window, the outcome, the figures and the snapshot they were computed from. */
export function snapshotHashInput(report: Omit<PublishedReport, 'contentHash' | 'publishedAt'>): unknown {
  return {
    reportDate: report.reportDate,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    status: report.status,
    missingSources: report.missingSources,
    totals: report.totals,
    figures: report.figures,
    signIns: report.signIns,
    riskDetections: report.riskDetections,
    riskyUsers: report.riskyUsers,
    riskFlags: report.riskFlags,
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/* SHA-256 over key-sorted JSON, so the hash survives a jsonb round trip. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
