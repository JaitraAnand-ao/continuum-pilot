import { sql } from 'drizzle-orm'
import { check, date, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'string' })

export const SIGN_IN_TYPES = ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity'] as const
export type SignInType = (typeof SIGN_IN_TYPES)[number]

/* What a report can be missing: one source per sign-in type, plus Identity Protection risk data. */
export const REPORT_SOURCES = [
  'signIns.interactiveUser',
  'signIns.nonInteractiveUser',
  'signIns.servicePrincipal',
  'signIns.managedIdentity',
  'identityProtection.riskDetections',
] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]

export const REPORT_STATUSES = ['complete', 'incomplete'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export interface ReportSnapshot {
  signIns: unknown[]
  riskDetections: unknown[]
}

/* ST-2: the one published report per UTC day, with the snapshot its figures were computed from. The window is
 * exactly [D 00:00Z, D+1 00:00Z); a report is complete exactly when no source is missing. Migration 0001 adds the
 * trigger that reconciles the figures to the snapshot and the triggers that reject UPDATE and TRUNCATE. */
export const report = pgTable(
  'report',
  {
    reportDate: date('report_date', { mode: 'string' }).primaryKey(),
    windowStart: instant('window_start').notNull(),
    windowEnd: instant('window_end').notNull(),
    status: text('status').$type<ReportStatus>().notNull(),
    missingSources: text('missing_sources').array().$type<ReportSource[]>().notNull(),
    total: integer('total').notNull(),
    successful: integer('successful').notNull(),
    failed: integer('failed').notNull(),
    snapshot: jsonb('snapshot').$type<ReportSnapshot>().notNull(),
    contentHash: text('content_hash').notNull(),
    publishedAt: instant('published_at').notNull(),
  },
  (t) => [
    check(
      'report_window_is_the_utc_day',
      sql`${t.windowStart} = (${t.reportDate}::timestamp AT TIME ZONE 'UTC') AND ${t.windowEnd} = ${t.windowStart} + interval '1 day'`,
    ),
    check('report_status_known', sql`${t.status} IN ('complete', 'incomplete')`),
    check(
      'report_missing_sources_known',
      sql`${t.missingSources} <@ ARRAY['signIns.interactiveUser', 'signIns.nonInteractiveUser', 'signIns.servicePrincipal', 'signIns.managedIdentity', 'identityProtection.riskDetections']::text[]`,
    ),
    check(
      'report_complete_iff_nothing_missing',
      sql`(${t.status} = 'complete') = (cardinality(${t.missingSources}) = 0)`,
    ),
    check(
      'report_totals_add_up',
      sql`${t.successful} >= 0 AND ${t.failed} >= 0 AND ${t.total} = ${t.successful} + ${t.failed}`,
    ),
    check(
      'report_snapshot_shape',
      sql`coalesce(jsonb_typeof(${t.snapshot} -> 'signIns') = 'array' AND jsonb_typeof(${t.snapshot} -> 'riskDetections') = 'array', false)`,
    ),
    check('report_content_hash_sha256_hex', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('report_published_after_window', sql`${t.publishedAt} >= ${t.windowEnd}`),
  ],
)

/* ST-2 AC-5: a day for which nothing could be collected by the cut-off, recorded instead of a report. The job may
 * record it again (upsert); migration 0001 rejects the record once a report for the day exists. */
export const reportNotGenerated = pgTable(
  'report_not_generated',
  {
    reportDate: date('report_date', { mode: 'string' }).primaryKey(),
    missingSources: text('missing_sources').array().$type<ReportSource[]>().notNull(),
    recordedAt: instant('recorded_at').notNull(),
  },
  (t) => [
    check(
      'report_not_generated_missing_sources_known',
      sql`cardinality(${t.missingSources}) > 0 AND ${t.missingSources} <@ ARRAY['signIns.interactiveUser', 'signIns.nonInteractiveUser', 'signIns.servicePrincipal', 'signIns.managedIdentity', 'identityProtection.riskDetections']::text[]`,
    ),
    check(
      'report_not_generated_after_day',
      sql`${t.recordedAt} >= ((${t.reportDate} + 1)::timestamp AT TIME ZONE 'UTC')`,
    ),
  ],
)
