/* CMP-5 schema for ST-1: the BFF session store (AD-5) and the append-only audit log.
 * Triggers, functions and grants that Drizzle cannot express live in the custom
 * migration next to the generated one (packages/db/migrations). */
import { sql } from 'drizzle-orm'
import { bigint, check, customType, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })
const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' })

export const APP_ROLES = ['reader', 'report_admin'] as const
export type AppRole = (typeof APP_ROLES)[number]

/* One row per browser session. The cookie value never reaches the database: only its
 * SHA-256 hash (id_hash) does, and the refresh token is stored as AES-256-GCM output
 * (12-byte IV, ciphertext, 16-byte tag). There is no column for an access token.
 * The sessions_guard trigger keeps an ended row final and its identity and absolute limit fixed. */
export const sessions = pgTable(
  'sessions',
  {
    idHash: bytea('id_hash').primaryKey(),
    subject: text('subject').notNull(),
    accountName: text('account_name').notNull(),
    roles: text('roles').array().$type<AppRole[]>().notNull(),
    refreshTokenCiphertext: bytea('refresh_token_ciphertext').notNull(),
    idpSessionId: text('idp_session_id'),
    createdAt: instant('created_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    idleExpiresAt: instant('idle_expires_at').notNull(),
    absoluteExpiresAt: instant('absolute_expires_at').notNull(),
    endedAt: instant('ended_at'),
  },
  (t) => [
    check('sessions_id_hash_is_sha256', sql`octet_length(${t.idHash}) = 32`),
    check('sessions_refresh_token_is_gcm', sql`octet_length(${t.refreshTokenCiphertext}) > 28`),
    check('sessions_roles_known', sql`${t.roles} <@ ARRAY['reader', 'report_admin']::text[]`),
    check('sessions_last_seen_after_created', sql`${t.lastSeenAt} >= ${t.createdAt}`),
    check('sessions_absolute_at_most_8h', sql`${t.absoluteExpiresAt} <= ${t.createdAt} + interval '8 hours'`),
    check('sessions_idle_at_most_15m', sql`${t.idleExpiresAt} <= ${t.lastSeenAt} + interval '15 minutes'`),
    check('sessions_idle_within_absolute', sql`${t.idleExpiresAt} <= ${t.absoluteExpiresAt}`),
    index('sessions_absolute_expires_at_idx').on(t.absoluteExpiresAt),
    index('sessions_idle_expires_at_idx').on(t.idleExpiresAt),
  ],
)

export const AUDIT_EVENT_TYPES = ['sign_in', 'sign_in_failed', 'access_denied', 'sign_out', 'session_expired'] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

/* Append-only: UPDATE, DELETE and TRUNCATE are rejected by trigger. id, prev_hash and
 * hash are assigned by the audit_events_chain trigger under an advisory lock, so the
 * values a caller supplies for them are discarded. reason holds codes, never prose. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().default(0),
    occurredAt: instant('occurred_at').notNull(),
    eventType: text('event_type').$type<AuditEventType>().notNull(),
    subject: text('subject'),
    reason: text('reason'),
    traceId: text('trace_id').notNull(),
    prevHash: bytea('prev_hash'),
    hash: bytea('hash')
      .notNull()
      .default(sql`'\\x'::bytea`),
  },
  (t) => [
    check(
      'audit_events_event_type_known',
      sql`${t.eventType} IN ('sign_in', 'sign_in_failed', 'access_denied', 'sign_out', 'session_expired')`,
    ),
    check('audit_events_reason_is_code', sql`${t.reason} ~ '^[A-Za-z0-9_.:-]{1,64}$'`),
    check('audit_events_trace_id_w3c', sql`${t.traceId} ~ '^[0-9a-f]{32}$' AND ${t.traceId} <> repeat('0', 32)`),
    index('audit_events_subject_idx').on(t.subject),
    index('audit_events_occurred_at_idx').on(t.occurredAt),
  ],
)
