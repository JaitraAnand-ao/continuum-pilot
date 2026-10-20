import { eq } from 'drizzle-orm'
import { guarded, type Database } from './client.js'
import { reportNotGenerated, SIGN_IN_SCOPES, type ReportSource, type ReportStatus, type SignInScope } from './schema.js'

export interface ApplicationFigures {
  appId: string
  appDisplayName: string
  total: number
  successful: number
  failed: number
}

export interface ErrorCodeFigures {
  errorCode: number
  failed: number
}

export interface ScopeFigures {
  total: number
  successful: number
  failed: number
  errorCodeCount: number
  /* Busiest first. */
  applications: ApplicationFigures[]
  /* Most failures first. */
  errorCodes: ErrorCodeFigures[]
}

/* A published report as stored; instants are UTC ISO-8601 with milliseconds. The snapshot evidence is not read. */
export interface StoredReport {
  reportDate: string
  windowStart: string
  windowEnd: string
  status: ReportStatus
  missingSources: ReportSource[]
  totals: { total: number; successful: number; failed: number }
  contentHash: string
  publishedAt: string
  /* Null for a report published before its figures were stored. */
  figures: Record<SignInScope, ScopeFigures> | null
}

export interface NotGeneratedDay {
  reportDate: string
  missingSources: ReportSource[]
  recordedAt: string
}

/* ST-3: what the BFF serves the Daily report from. It reads the stored rows and computes nothing, so every view of
 * a day shows the figures as they were published (AC-10). */
export interface ReportReader {
  /* The published report for the UTC date (YYYY-MM-DD), or null while it is not published. */
  findPublished(reportDate: string): Promise<StoredReport | null>
  /* The day recorded as not generated, or null. */
  findNotGenerated(reportDate: string): Promise<NotGeneratedDay | null>
}

export function createReportReader(db: Database): ReportReader {
  return guarded({
    async findPublished(reportDate) {
      /* One statement, so the report and its figures are read from one snapshot. */
      const report = await db.query.reports.findFirst({
        columns: { snapshot: false },
        where: (r, { eq }) => eq(r.reportDate, reportDate),
        with: {
          figures: {
            columns: { reportDate: false },
            with: {
              /* Busiest first, ties by application ID, so the order does not depend on the collation. */
              applications: {
                columns: { appId: true, appDisplayName: true, total: true, successful: true, failed: true },
                orderBy: (a, { asc, desc }) => [desc(a.total), asc(a.appId)],
              },
              errorCodes: {
                columns: { errorCode: true, failed: true },
                orderBy: (e, { asc, desc }) => [desc(e.failed), asc(e.errorCode)],
              },
            },
          },
        },
      })
      if (!report) return null

      /* The reconciliation trigger guarantees all five sign-in types once any is stored. */
      const figures = [...report.figures].sort(
        (a, b) => SIGN_IN_SCOPES.indexOf(a.signInType) - SIGN_IN_SCOPES.indexOf(b.signInType),
      )
      return {
        reportDate: report.reportDate,
        windowStart: report.windowStart.toISOString(),
        windowEnd: report.windowEnd.toISOString(),
        status: report.status,
        missingSources: report.missingSources,
        totals: { total: report.total, successful: report.successful, failed: report.failed },
        contentHash: report.contentHash,
        publishedAt: report.publishedAt.toISOString(),
        figures:
          figures.length === 0
            ? null
            : (Object.fromEntries(figures.map(({ signInType, ...scope }) => [signInType, scope])) as Record<
                SignInScope,
                ScopeFigures
              >),
      }
    },

    async findNotGenerated(reportDate) {
      const [day] = await db.select().from(reportNotGenerated).where(eq(reportNotGenerated.reportDate, reportDate))
      if (!day) return null
      return {
        reportDate: day.reportDate,
        missingSources: day.missingSources,
        recordedAt: day.recordedAt.toISOString(),
      }
    },
  })
}
