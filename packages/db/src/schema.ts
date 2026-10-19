/* CMP-5 schema for ST-2: one immutable report per UTC day and the sign-in snapshot it was computed from.
 * What Drizzle cannot express (immutability, window and reconciliation triggers, grants) lives in the
 * custom migration beside the generated one. */
import { sql } from 'drizzle-orm'
import {
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const reportStatus = pgEnum('report_status', ['complete', 'incomplete', 'not_generated'])

/** Graph's signInEventTypes values, the four sign-in types a report covers (AC-2). */
export const signInType = pgEnum('sign_in_type', [
  'interactiveUser',
  'nonInteractiveUser',
  'servicePrincipal',
  'managedIdentity',
])
export const signInTypes = signInType.enumValues

const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' })

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    windowStart: instant('window_start').notNull(),
    windowEnd: instant('window_end').notNull(),
    status: reportStatus('status').notNull(),
    missingSources: text('missing_sources')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    totalCount: integer('total_count').notNull(),
    successfulCount: integer('successful_count').notNull(),
    failedCount: integer('failed_count').notNull(),
    contentHash: char('content_hash', { length: 64 }),
    configVersionId: uuid('config_version_id').notNull(),
    publishedAt: instant('published_at'),
    recordedAt: instant('recorded_at').notNull(),
  },
  (t) => [
    uniqueIndex('reports_report_date_key').on(t.reportDate),
    check(
      'reports_window_is_the_utc_day',
      sql`${t.windowStart} = (${t.reportDate}::timestamp AT TIME ZONE 'UTC') AND ${t.windowEnd} = ${t.windowStart} + interval '1 day'`,
    ),
    check(
      'reports_counts_reconcile',
      sql`${t.successfulCount} >= 0 AND ${t.failedCount} >= 0 AND ${t.totalCount} = ${t.successfulCount} + ${t.failedCount}`,
    ),
    check('reports_content_hash_is_sha256', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'reports_status_matches_contents',
      sql`(${t.status} = 'complete' AND cardinality(${t.missingSources}) = 0 AND ${t.contentHash} IS NOT NULL AND ${t.publishedAt} IS NOT NULL)
       OR (${t.status} = 'incomplete' AND cardinality(${t.missingSources}) > 0 AND ${t.contentHash} IS NOT NULL AND ${t.publishedAt} IS NOT NULL)
       OR (${t.status} = 'not_generated' AND cardinality(${t.missingSources}) > 0 AND ${t.contentHash} IS NULL AND ${t.publishedAt} IS NULL AND ${t.totalCount} = 0)`,
    ),
  ],
)

export const signinSnapshots = pgTable(
  'signin_snapshots',
  {
    reportId: uuid('report_id').notNull(),
    signInId: text('sign_in_id').notNull(),
    signInType: signInType('sign_in_type').notNull(),
    createdAt: instant('created_at').notNull(),
    errorCode: integer('error_code').notNull(),
    appliedConditionalAccessPolicies: jsonb('applied_conditional_access_policies').notNull(),
    deviceDetail: jsonb('device_detail').notNull(),
    record: jsonb('record').notNull(),
  },
  (t) => [
    primaryKey({ name: 'signin_snapshots_pkey', columns: [t.reportId, t.signInId] }),
    foreignKey({ name: 'signin_snapshots_report_id_fkey', columns: [t.reportId], foreignColumns: [reports.id] }),
    index('signin_snapshots_report_id_sign_in_type_idx').on(t.reportId, t.signInType),
    check(
      'signin_snapshots_evidence_shape',
      sql`jsonb_typeof(${t.appliedConditionalAccessPolicies}) = 'array' AND jsonb_typeof(${t.deviceDetail}) = 'object' AND jsonb_typeof(${t.record}) = 'object'`,
    ),
  ],
)
