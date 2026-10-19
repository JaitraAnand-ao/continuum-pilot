import type { RiskDetection, SignIn, SignInType } from './ports.js'

export interface ReportTotals {
  readonly total: number
  readonly successful: number
  readonly failed: number
  readonly byType: Readonly<Record<SignInType, number>>
}

export interface NewReport {
  readonly reportDate: string
  readonly windowStart: string
  readonly windowEnd: string
  readonly publishedAt: string
  readonly complete: boolean
  readonly missingSources: readonly string[]
  readonly totals: ReportTotals
  readonly signIns: readonly SignIn[]
  readonly riskDetections: readonly RiskDetection[]
  readonly contentHash: string
}

export type StoredReport = NewReport

export interface NotGeneratedRecord {
  readonly reportDate: string
  readonly recordedAt: string
  readonly missingSources: readonly string[]
}

export class ReportAlreadyPublishedError extends Error {
  constructor(readonly reportDate: string) {
    super(`a report for ${reportDate} is already published`)
    this.name = 'ReportAlreadyPublishedError'
  }
}

/**
 * IF-15: where the job publishes. An implementation writes the snapshot, the figures and
 * the hash in one transaction and refuses a second report for the same date.
 */
export interface ReportStore {
  findPublished(reportDate: string): Promise<StoredReport | null>
  publish(report: NewReport): Promise<StoredReport>
  recordNotGenerated(record: NotGeneratedRecord): Promise<void>
  findNotGenerated(reportDate: string): Promise<NotGeneratedRecord | null>
  list(): Promise<StoredReport[]>
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** For local runs and tests; production uses the Postgres store from packages/db. */
export function createInMemoryReportStore(): ReportStore {
  const published = new Map<string, StoredReport>()
  const notGenerated = new Map<string, NotGeneratedRecord>()
  return {
    async findPublished(reportDate) {
      return published.get(reportDate) ?? null
    },
    async publish(report) {
      if (published.has(report.reportDate)) throw new ReportAlreadyPublishedError(report.reportDate)
      const stored = deepFreeze(structuredClone(report))
      published.set(report.reportDate, stored)
      notGenerated.delete(report.reportDate)
      return stored
    },
    async recordNotGenerated(record) {
      notGenerated.set(record.reportDate, deepFreeze(structuredClone(record)))
    },
    async findNotGenerated(reportDate) {
      return notGenerated.get(reportDate) ?? null
    },
    async list() {
      return [...published.values()].sort((a, b) => a.reportDate.localeCompare(b.reportDate))
    },
  }
}
