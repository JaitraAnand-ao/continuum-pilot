import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })
const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3 })

/* AD-5: the BFF session. The cookie's session ID is held only as its SHA-256; the refresh token only as
 * AES-256-GCM ciphertext with its 96-bit nonce and 128-bit tag. Idle and absolute deadlines are computed by the
 * caller from its injected Clock; the idle deadline can never pass the absolute one. */
export const sessions = pgTable(
  'sessions',
  {
    idHash: bytea('id_hash').primaryKey(),
    subjectOid: uuid('subject_oid').notNull(),
    accountName: text('account_name').notNull(),
    roles: text('roles').array().notNull(),
    refreshTokenCiphertext: bytea('refresh_token_ciphertext').notNull(),
    refreshTokenIv: bytea('refresh_token_iv').notNull(),
    refreshTokenTag: bytea('refresh_token_tag').notNull(),
    refreshTokenKeyId: text('refresh_token_key_id').notNull(),
    idpSessionId: text('idp_session_id'),
    createdAt: instant('created_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    idleExpiresAt: instant('idle_expires_at').notNull(),
    absoluteExpiresAt: instant('absolute_expires_at').notNull(),
  },
  (t) => [
    check('sessions_id_hash_sha256', sql`octet_length(${t.idHash}) = 32`),
    check('sessions_refresh_token_iv_96_bit', sql`octet_length(${t.refreshTokenIv}) = 12`),
    check('sessions_refresh_token_tag_128_bit', sql`octet_length(${t.refreshTokenTag}) = 16`),
    check('sessions_refresh_token_present', sql`octet_length(${t.refreshTokenCiphertext}) > 0`),
    check('sessions_idle_within_absolute', sql`${t.idleExpiresAt} <= ${t.absoluteExpiresAt}`),
    check('sessions_absolute_after_created', sql`${t.absoluteExpiresAt} > ${t.createdAt}`),
    index('sessions_idle_expires_at_idx').on(t.idleExpiresAt),
    index('sessions_absolute_expires_at_idx').on(t.absoluteExpiresAt),
  ],
)

export const AUDIT_EVENT_TYPES = ['access_denied'] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

/* Append-only audit trail. prev_hash and hash are set by a trigger that chains each row to the one before it;
 * UPDATE, DELETE and TRUNCATE are rejected by triggers (migration 0001). */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: instant('occurred_at').notNull(),
    eventType: text('event_type').$type<AuditEventType>().notNull(),
    actorOid: uuid('actor_oid'),
    actorName: text('actor_name'),
    target: text('target'),
    traceId: text('trace_id').notNull(),
    prevHash: bytea('prev_hash'),
    hash: bytea('hash').notNull(),
  },
  (t) => [
    check('audit_events_event_type_known', sql`${t.eventType} IN ('access_denied')`),
    check('audit_events_trace_id_w3c', sql`${t.traceId} ~ '^[0-9a-f]{32}$'`),
    index('audit_events_occurred_at_idx').on(t.occurredAt),
    index('audit_events_actor_oid_idx').on(t.actorOid),
  ],
)

/* ST-2: the sources a daily report is collected from; a report or a not-generated day names the ones that failed. */
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

const KNOWN_SOURCES = sql`ARRAY['signIns.interactiveUser', 'signIns.nonInteractiveUser', 'signIns.servicePrincipal', 'signIns.managedIdentity', 'identityProtection.riskDetections']::text[]`

/* One published report per UTC day, written once with its snapshot in a single statement and never changed:
 * UPDATE and TRUNCATE are rejected by triggers (migration 0003). The window is exactly 00:00Z of the date up to
 * 00:00Z of the next; the totals reconcile to the stored sign-ins; a complete report names no missing source. */
export const reports = pgTable(
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
    snapshot: jsonb('snapshot').notNull(),
    contentHash: text('content_hash').notNull(),
    publishedAt: instant('published_at').notNull(),
  },
  (t) => [
    check(
      'report_window_is_utc_day',
      sql`${t.windowStart} = (${t.reportDate}::timestamp AT TIME ZONE 'UTC') AND ${t.windowEnd} = ((${t.reportDate} + 1)::timestamp AT TIME ZONE 'UTC')`,
    ),
    check('report_published_after_window', sql`${t.publishedAt} >= ${t.windowEnd}`),
    check('report_status_known', sql`${t.status} IN ('complete', 'incomplete')`),
    check('report_missing_sources_known', sql`${t.missingSources} <@ ${KNOWN_SOURCES}`),
    check(
      'report_status_matches_missing_sources',
      sql`(${t.status} = 'complete') = (cardinality(${t.missingSources}) = 0)`,
    ),
    check('report_counts_non_negative', sql`${t.successful} >= 0 AND ${t.failed} >= 0`),
    check('report_total_is_successful_plus_failed', sql`${t.total} = ${t.successful} + ${t.failed}`),
    check(
      'report_total_matches_snapshot',
      sql`CASE WHEN jsonb_typeof(${t.snapshot} -> 'signIns') = 'array' THEN jsonb_array_length(${t.snapshot} -> 'signIns') = ${t.total} ELSE false END`,
    ),
    check('report_content_hash_sha256', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    index('report_published_at_idx').on(t.publishedAt),
  ],
)

/* A day for which no source could be collected by the retry deadline; it is never shown as a report. The worker
 * may record the same day again, so this table alone is upserted. */
export const reportNotGenerated = pgTable(
  'report_not_generated',
  {
    reportDate: date('report_date', { mode: 'string' }).primaryKey(),
    missingSources: text('missing_sources').array().$type<ReportSource[]>().notNull(),
    recordedAt: instant('recorded_at').notNull(),
  },
  (t) => [
    check('report_not_generated_missing_sources_present', sql`cardinality(${t.missingSources}) > 0`),
    check('report_not_generated_missing_sources_known', sql`${t.missingSources} <@ ${KNOWN_SOURCES}`),
  ],
)

/* ST-3: the Daily report's sign-in type control. 'all' is All types; the others are Graph's signInEventType. */
export const SIGN_IN_SCOPES = [
  'all',
  'interactiveUser',
  'nonInteractiveUser',
  'servicePrincipal',
  'managedIdentity',
] as const
export type SignInScope = (typeof SIGN_IN_SCOPES)[number]

/* The figures the Daily report shows, computed from the snapshot by the report worker and written in the publish
 * transaction, so a view reads them as published and never recomputes them. Per report there is one row for All
 * types and one for each sign-in type, zeros included. A deferred constraint trigger (migration 0005) checks at
 * commit that All types equals the report row, the four types add up to All types, and each type's applications
 * and error codes add up to its tiles; UPDATE and TRUNCATE are rejected. Purging the report removes its figures. */
export const reportFigures = pgTable(
  'report_figures',
  {
    reportDate: date('report_date', { mode: 'string' })
      .notNull()
      .references(() => reports.reportDate, { onDelete: 'cascade' }),
    signInType: text('sign_in_type').$type<SignInScope>().notNull(),
    total: integer('total').notNull(),
    successful: integer('successful').notNull(),
    failed: integer('failed').notNull(),
    errorCodeCount: integer('error_code_count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reportDate, t.signInType] }),
    check(
      'report_figures_sign_in_type_known',
      sql`${t.signInType} IN ('all', 'interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity')`,
    ),
    check('report_figures_counts_non_negative', sql`${t.successful} >= 0 AND ${t.failed} >= 0`),
    check('report_figures_total_is_successful_plus_failed', sql`${t.total} = ${t.successful} + ${t.failed}`),
    check(
      'report_figures_error_codes_within_failed',
      sql`${t.errorCodeCount} <= ${t.failed} AND (${t.failed} = 0) = (${t.errorCodeCount} = 0)`,
    ),
  ],
)

/* One row per application with at least one sign-in of the type that day. */
export const reportApplicationFigures = pgTable(
  'report_application_figures',
  {
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    signInType: text('sign_in_type').$type<SignInScope>().notNull(),
    appId: text('app_id').notNull(),
    appDisplayName: text('app_display_name').notNull(),
    total: integer('total').notNull(),
    successful: integer('successful').notNull(),
    failed: integer('failed').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reportDate, t.signInType, t.appId] }),
    foreignKey({
      columns: [t.reportDate, t.signInType],
      foreignColumns: [reportFigures.reportDate, reportFigures.signInType],
      name: 'report_application_figures_scope_fk',
    }).onDelete('cascade'),
    check('report_application_figures_counts_non_negative', sql`${t.successful} >= 0 AND ${t.failed} >= 0`),
    check(
      'report_application_figures_total_is_successful_plus_failed',
      sql`${t.total} = ${t.successful} + ${t.failed}`,
    ),
    check('report_application_figures_has_sign_ins', sql`${t.total} > 0`),
  ],
)

/* One row per non-zero error code the type's failed sign-ins carried that day. */
export const reportErrorCodeFigures = pgTable(
  'report_error_code_figures',
  {
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    signInType: text('sign_in_type').$type<SignInScope>().notNull(),
    errorCode: integer('error_code').notNull(),
    failed: integer('failed').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reportDate, t.signInType, t.errorCode] }),
    foreignKey({
      columns: [t.reportDate, t.signInType],
      foreignColumns: [reportFigures.reportDate, reportFigures.signInType],
      name: 'report_error_code_figures_scope_fk',
    }).onDelete('cascade'),
    check('report_error_code_figures_code_is_failure', sql`${t.errorCode} <> 0`),
    check('report_error_code_figures_has_failures', sql`${t.failed} > 0`),
  ],
)

/* How the reader loads a report with its figures in one statement, and so from one snapshot. */
export const reportRelations = relations(reports, ({ many }) => ({ figures: many(reportFigures) }))

export const reportFiguresRelations = relations(reportFigures, ({ one, many }) => ({
  report: one(reports, { fields: [reportFigures.reportDate], references: [reports.reportDate] }),
  applications: many(reportApplicationFigures),
  errorCodes: many(reportErrorCodeFigures),
}))

export const reportApplicationFiguresRelations = relations(reportApplicationFigures, ({ one }) => ({
  scope: one(reportFigures, {
    fields: [reportApplicationFigures.reportDate, reportApplicationFigures.signInType],
    references: [reportFigures.reportDate, reportFigures.signInType],
  }),
}))

export const reportErrorCodeFiguresRelations = relations(reportErrorCodeFigures, ({ one }) => ({
  scope: one(reportFigures, {
    fields: [reportErrorCodeFigures.reportDate, reportErrorCodeFigures.signInType],
    references: [reportFigures.reportDate, reportFigures.signInType],
  }),
}))
