import { type SQL, sql } from 'drizzle-orm'
import {
  bigint,
  check,
  customType,
  date,
  boolean,
  foreignKey,
  index,
  inet,
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
  'identityProtection.riskyUsers',
] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]

export const REPORT_STATUSES = ['complete', 'incomplete'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

const KNOWN_SOURCES = sql`ARRAY['signIns.interactiveUser', 'signIns.nonInteractiveUser', 'signIns.servicePrincipal', 'signIns.managedIdentity', 'identityProtection.riskDetections', 'identityProtection.riskyUsers']::text[]`

/* ST-9: when either Identity Protection collection is missing, neither risk category can be evaluated. */
export const IDENTITY_PROTECTION_SOURCES = [
  'identityProtection.riskDetections',
  'identityProtection.riskyUsers',
] as const satisfies readonly ReportSource[]
const IDENTITY_PROTECTION = sql`ARRAY['identityProtection.riskDetections', 'identityProtection.riskyUsers']::text[]`

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
    /* ST-9: NULL when Identity Protection could not be read, so a category not evaluated is never a quiet zero. */
    riskySignIns: integer('risky_sign_ins'),
    riskyUsers: integer('risky_users'),
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
    check('report_risky_counts_evaluated_together', sql`(${t.riskySignIns} IS NULL) = (${t.riskyUsers} IS NULL)`),
    check('report_risky_counts_non_negative', sql`${t.riskySignIns} >= 0 AND ${t.riskyUsers} >= 0`),
    check(
      'report_risky_not_evaluated_without_identity_protection',
      sql`NOT (${t.missingSources} && ${IDENTITY_PROTECTION}) OR (${t.riskySignIns} IS NULL AND ${t.riskyUsers} IS NULL)`,
    ),
    check(
      'report_risky_snapshot_holds_risk_data',
      sql`${t.riskySignIns} IS NULL OR COALESCE(jsonb_typeof(${t.snapshot} -> 'riskDetections') = 'array' AND jsonb_typeof(${t.snapshot} -> 'riskyUsers') = 'array', false)`,
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

/* ST-9: the level a flag is raised at or above, the user risk states that are flagged, and the Conditional Access
 * results Entra records. The rule itself is applied in domain; these CHECKs keep a stored flag consistent with it. */
export const RISK_TRIGGER_LEVELS = ['medium', 'high'] as const
export type RiskTriggerLevel = (typeof RISK_TRIGGER_LEVELS)[number]

export const FLAGGED_RISK_STATES = ['atRisk', 'confirmedCompromised'] as const
export type FlaggedRiskState = (typeof FLAGGED_RISK_STATES)[number]

export const CONDITIONAL_ACCESS_STATUSES = ['success', 'failure', 'notApplied', 'unknownFutureValue'] as const
export type ConditionalAccessStatus = (typeof CONDITIONAL_ACCESS_STATUSES)[number]

/* The order of the levels a flag may hold; NULL for low, none and anything else, which no flag may hold. */
const riskRank = (level: SQL) => sql`(CASE ${level} WHEN 'medium' THEN 2 WHEN 'high' THEN 3 END)`
const meetsTrigger = (observed: SQL, trigger: SQL) =>
  sql`${riskRank(observed)} IS NOT NULL AND ${riskRank(trigger)} IS NOT NULL AND ${riskRank(observed)} >= ${riskRank(trigger)}`
/* Holds at least one character that is not whitespace (a tab or newline alone is blank too). */
const present = (field: SQL) => sql`${field} ~ '[^[:space:]]'`
/* An evidence field Entra left empty is stored as NULL, read as not recorded; a blank string is never stored. */
const recordedOrNull = (...fields: SQL[]) =>
  sql.join(
    fields.map((f) => present(f)),
    sql` AND `,
  )

export interface RiskDetectionEvidence {
  id: string
  riskEventType: string
  riskLevel: string
  detectedDateTime: string
}

/* One row per sign-in flagged in a published report, with the trigger it was raised against, the observed
 * aggregated risk level and its evidence. Written with the report and never changed: UPDATE and TRUNCATE are
 * rejected by triggers, and the report's risky_sign_ins must equal its rows at commit (migration 0005). */
export const reportRiskySignInFlags = pgTable(
  'report_risky_sign_in_flag',
  {
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    /* The sign-in's id, shown in Entra as its request ID. */
    requestId: text('request_id').notNull(),
    triggerLevel: text('trigger_level').$type<RiskTriggerLevel>().notNull(),
    observedRiskLevel: text('observed_risk_level').$type<RiskTriggerLevel>().notNull(),
    signedInAt: instant('signed_in_at').notNull(),
    userId: text('user_id'),
    userPrincipalName: text('user_principal_name'),
    appId: text('app_id'),
    appDisplayName: text('app_display_name'),
    ipAddress: inet('ip_address'),
    location: text('location'),
    deviceCompliant: boolean('device_compliant'),
    conditionalAccessStatus: text('conditional_access_status').$type<ConditionalAccessStatus>(),
  },
  (t) => [
    primaryKey({ columns: [t.reportDate, t.requestId] }),
    foreignKey({ columns: [t.reportDate], foreignColumns: [reports.reportDate] }).onDelete('cascade'),
    check('report_risky_sign_in_flag_request_id_present', present(sql`${t.requestId}`)),
    check(
      'report_risky_sign_in_flag_observed_meets_trigger',
      meetsTrigger(sql`${t.observedRiskLevel}`, sql`${t.triggerLevel}`),
    ),
    check(
      'report_risky_sign_in_flag_signed_in_within_day',
      sql`${t.signedInAt} >= (${t.reportDate}::timestamp AT TIME ZONE 'UTC') AND ${t.signedInAt} < ((${t.reportDate} + 1)::timestamp AT TIME ZONE 'UTC')`,
    ),
    check(
      'report_risky_sign_in_flag_blank_is_not_recorded',
      recordedOrNull(
        sql`${t.userId}`,
        sql`${t.userPrincipalName}`,
        sql`${t.appId}`,
        sql`${t.appDisplayName}`,
        sql`${t.location}`,
      ),
    ),
    check(
      'report_risky_sign_in_flag_conditional_access_known',
      sql`${t.conditionalAccessStatus} IN ('success', 'failure', 'notApplied', 'unknownFutureValue')`,
    ),
  ],
)

/* One row per user flagged in a published report, with every contributing risk detection and the IDs of the
 * user's sign-ins in the window. Immutable and reconciled to risky_users like the sign-in flags. */
export const reportRiskyUserFlags = pgTable(
  'report_risky_user_flag',
  {
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    userId: text('user_id').notNull(),
    userPrincipalName: text('user_principal_name'),
    userDisplayName: text('user_display_name'),
    triggerLevel: text('trigger_level').$type<RiskTriggerLevel>().notNull(),
    riskState: text('risk_state').$type<FlaggedRiskState>().notNull(),
    riskLevel: text('risk_level').$type<RiskTriggerLevel>().notNull(),
    detections: jsonb('detections').$type<RiskDetectionEvidence[]>().notNull(),
    signInIds: text('sign_in_ids').array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reportDate, t.userId] }),
    foreignKey({ columns: [t.reportDate], foreignColumns: [reports.reportDate] }).onDelete('cascade'),
    check('report_risky_user_flag_user_id_present', present(sql`${t.userId}`)),
    check('report_risky_user_flag_state_flagged', sql`${t.riskState} IN ('atRisk', 'confirmedCompromised')`),
    check('report_risky_user_flag_level_meets_trigger', meetsTrigger(sql`${t.riskLevel}`, sql`${t.triggerLevel}`)),
    check(
      'report_risky_user_flag_detections_complete',
      sql`jsonb_typeof(${t.detections}) = 'array' AND NOT jsonb_path_exists(${t.detections}, 'strict $[*] ? (@.type() != "object")') AND NOT jsonb_path_exists(${t.detections}, '$[*] ? (!(@.id.type() == "string" && @.riskEventType.type() == "string" && @.detectedDateTime.type() == "string" && @.id like_regex "\\\\S" && @.riskEventType like_regex "\\\\S" && (@.riskLevel == "none" || @.riskLevel == "low" || @.riskLevel == "medium" || @.riskLevel == "high" || @.riskLevel == "hidden" || @.riskLevel == "unknownFutureValue") && @.detectedDateTime like_regex "^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}"))')`,
    ),
    check(
      'report_risky_user_flag_sign_in_ids_present',
      sql`NOT jsonb_path_exists(to_jsonb(${t.signInIds}), '$[*] ? (@ == null || !(@ like_regex "\\\\S"))')`,
    ),
    check(
      'report_risky_user_flag_blank_is_not_recorded',
      recordedOrNull(sql`${t.userPrincipalName}`, sql`${t.userDisplayName}`),
    ),
    index('report_risky_user_flag_user_id_idx').on(t.userId),
  ],
)
