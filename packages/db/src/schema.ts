import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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

export const AUDIT_EVENT_TYPES = [
  'access_denied',
  'recipient.check_passed',
  'recipient.check_rejected',
  'recipient.check_failed',
  'recipient.proposed',
  'recipient.removed',
] as const
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
    check(
      'audit_events_event_type_known',
      sql`${t.eventType} IN ('access_denied', 'recipient.check_passed', 'recipient.check_rejected', 'recipient.check_failed', 'recipient.proposed', 'recipient.removed')`,
    ),
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

/* ST-18: who receives the daily email. A person or a distribution group is stored only after it passed the
 * reader-group check, waiting for a second administrator's approval; removal deletes the row at once. Only the
 * approval of a waiting recipient may change a row (trigger, migration 0005), and the approver is never the
 * administrator who proposed it (four-eyes, CHECK). */
export const RECIPIENT_KINDS = ['person', 'group'] as const
export type RecipientKind = (typeof RECIPIENT_KINDS)[number]

export const RECIPIENT_STATUSES = ['pending_approval', 'active'] as const
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number]

export const emailRecipients = pgTable(
  'email_recipient',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<RecipientKind>().notNull(),
    entraObjectId: uuid('entra_object_id').notNull(),
    displayName: text('display_name').notNull(),
    address: text('address').notNull(),
    memberCount: integer('member_count'),
    status: text('status').$type<RecipientStatus>().notNull(),
    addedByOid: uuid('added_by_oid').notNull(),
    addedByName: text('added_by_name').notNull(),
    proposedAt: instant('proposed_at').notNull(),
    approvedByOid: uuid('approved_by_oid'),
    approvedByName: text('approved_by_name'),
    approvedAt: instant('approved_at'),
  },
  (t) => [
    check('email_recipient_kind_known', sql`${t.kind} IN ('person', 'group')`),
    check('email_recipient_status_known', sql`${t.status} IN ('pending_approval', 'active')`),
    check(
      'email_recipient_member_count_matches_kind',
      sql`CASE ${t.kind} WHEN 'group' THEN coalesce(${t.memberCount} >= 1, false) ELSE ${t.memberCount} IS NULL END`,
    ),
    check('email_recipient_address_shape', sql`${t.address} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`),
    check(
      'email_recipient_status_matches_approval',
      sql`CASE ${t.status} WHEN 'active' THEN ${t.approvedByOid} IS NOT NULL AND ${t.approvedByName} IS NOT NULL AND ${t.approvedAt} IS NOT NULL ELSE ${t.approvedByOid} IS NULL AND ${t.approvedByName} IS NULL AND ${t.approvedAt} IS NULL END`,
    ),
    check('email_recipient_approver_is_not_proposer', sql`${t.approvedByOid} <> ${t.addedByOid}`),
    check('email_recipient_approval_after_proposal', sql`${t.approvedAt} >= ${t.proposedAt}`),
    uniqueIndex('email_recipient_entra_object_id_key').on(t.entraObjectId),
    index('email_recipient_status_idx').on(t.status),
  ],
)
