import { createHash } from 'node:crypto'
import type { ReportDraft } from './ports.js'

/* Key-sorted JSON, so a snapshot read back from jsonb hashes the same as the one written. */
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

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function contentHash(draft: Omit<ReportDraft, 'contentHash'>): string {
  const content = {
    ...draft,
    signIns: [...draft.signIns].sort(byId),
    riskDetections: [...draft.riskDetections].sort(byId),
  }
  return createHash('sha256').update(canonical(content)).digest('hex')
}
