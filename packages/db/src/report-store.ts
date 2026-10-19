/* The report store (ST-2): publish a day's report and its snapshot in one transaction, record a day
 * as not generated, and read reports back. A day already recorded is returned untouched, never replaced. */
import { and, asc, between, count, eq, isNotNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { reports, signinSnapshots, signInTypes } from './schema.js'

export type SignInType = (typeof signInTypes)[number]
export type StoredReport = typeof reports.$inferSelect

export interface SnapshotSignIn {
  readonly id: string
  readonly type: SignInType
  readonly createdAt: Date
  readonly errorCode: number
  readonly appliedConditionalAccessPolicies: readonly unknown[]
  readonly deviceDetail: Readonly<Record<string, unknown>>
  /** The sign-in as Graph returned it, kept as evidence. */
  readonly record: Readonly<Record<string, unknown>>
}

interface ReportDay {
  readonly reportDate: string
  readonly windowStart: Date
  readonly windowEnd: Date
  readonly configVersionId: string
}

export interface PublishReport extends ReportDay {
  /** Empty for a complete report; otherwise the sources that could not be collected. */
  readonly missingSources: readonly string[]
  readonly totals: { readonly total: number; readonly successful: number; readonly failed: number }
  readonly contentHash: string
  readonly publishedAt: Date
  readonly signIns: readonly SnapshotSignIn[]
}

export interface RecordNotGenerated extends ReportDay {
  readonly missingSources: readonly string[]
  readonly recordedAt: Date
}

export interface RecordResult {
  /** `already-recorded` when a report or not-generated record for the date existed before this call. */
  readonly outcome: 'published' | 'already-recorded'
  readonly report: StoredReport
}

/** Rows per snapshot INSERT: 8 parameters a row keeps each statement well under Postgres' 65,535. */
export const SNAPSHOT_CHUNK_ROWS = 1000

export type ReportDatabase = NodePgDatabase<Record<string, never>>

export function createReportStore(db: ReportDatabase) {
  const insertOnce = async (tx: ReportDatabase, values: typeof reports.$inferInsert): Promise<RecordResult> => {
    const [inserted] = await tx
      .insert(reports)
      .values(values)
      .onConflictDoNothing({ target: reports.reportDate })
      .returning()
    if (inserted) return { outcome: 'published', report: inserted }
    const [existing] = await tx.select().from(reports).where(eq(reports.reportDate, values.reportDate)).limit(1)
    if (!existing) throw new Error(`report for ${values.reportDate} was neither inserted nor found`)
    return { outcome: 'already-recorded', report: existing }
  }

  return {
    publish(input: PublishReport): Promise<RecordResult> {
      return db.transaction(async (tx) => {
        const result = await insertOnce(tx, {
          reportDate: input.reportDate,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          status: input.missingSources.length === 0 ? 'complete' : 'incomplete',
          missingSources: [...input.missingSources],
          totalCount: input.totals.total,
          successfulCount: input.totals.successful,
          failedCount: input.totals.failed,
          contentHash: input.contentHash,
          configVersionId: input.configVersionId,
          publishedAt: input.publishedAt,
          recordedAt: input.publishedAt,
        })
        if (result.outcome === 'already-recorded') return result
        for (let start = 0; start < input.signIns.length; start += SNAPSHOT_CHUNK_ROWS) {
          await tx.insert(signinSnapshots).values(
            input.signIns.slice(start, start + SNAPSHOT_CHUNK_ROWS).map((signIn) => ({
              reportId: result.report.id,
              signInId: signIn.id,
              signInType: signIn.type,
              createdAt: signIn.createdAt,
              errorCode: signIn.errorCode,
              appliedConditionalAccessPolicies: signIn.appliedConditionalAccessPolicies,
              deviceDetail: signIn.deviceDetail,
              record: signIn.record,
            })),
          )
        }
        return result
      })
    },

    recordNotGenerated(input: RecordNotGenerated): Promise<RecordResult> {
      return db.transaction((tx) =>
        insertOnce(tx, {
          reportDate: input.reportDate,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          status: 'not_generated',
          missingSources: [...input.missingSources],
          totalCount: 0,
          successfulCount: 0,
          failedCount: 0,
          contentHash: null,
          configVersionId: input.configVersionId,
          publishedAt: null,
          recordedAt: input.recordedAt,
        }),
      )
    },

    async findByDate(reportDate: string): Promise<StoredReport | undefined> {
      const [found] = await db.select().from(reports).where(eq(reports.reportDate, reportDate)).limit(1)
      return found
    },

    /** Published reports (complete or incomplete) whose date lies in [from, to], oldest first. */
    listPublished(from: string, to: string): Promise<StoredReport[]> {
      return db
        .select()
        .from(reports)
        .where(and(between(reports.reportDate, from, to), isNotNull(reports.publishedAt)))
        .orderBy(asc(reports.reportDate))
    },

    /** False for a missing, incomplete or not-generated day: the 07:30 UTC alarm's condition (AC-6). */
    async hasCompleteReport(reportDate: string): Promise<boolean> {
      const found = await db
        .select({ one: sql<number>`1` })
        .from(reports)
        .where(and(eq(reports.reportDate, reportDate), eq(reports.status, 'complete')))
        .limit(1)
      return found.length > 0
    },

    async countSnapshot(reportId: string): Promise<number> {
      const [counted] = await db
        .select({ n: count() })
        .from(signinSnapshots)
        .where(eq(signinSnapshots.reportId, reportId))
      return counted?.n ?? 0
    },
  }
}

export type ReportStore = ReturnType<typeof createReportStore>
