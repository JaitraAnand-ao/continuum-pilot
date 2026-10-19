/* CMP-5 schema. Every change here ships with its generated migration in ../migrations
 * (npm run generate -w @signin-reports/db); merged migration files are never edited. */
import { sql } from 'drizzle-orm'
import { bigint, check, customType, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' })

export const SESSION_ROLES = ['reader', 'report_admin'] as const
export type SessionRole = (typeof SESSION_ROLES)[number]

/* AD-5: the BFF session. The cookie carries a random session ID; only its SHA-256 is kept.
 * The refresh token is kept only as AES-256-GCM ciphertext with its IV and tag. The CHECKs
 * hold the 15-minute idle and 8-hour absolute limits even if a caller computes them wrong. */
export const session = pgTable(
  'session',
  {
    idHash: bytea('id_hash').primaryKey(),
    subject: text('subject').notNull(),
    accountName: text('account_name').notNull(),
    roles: text('roles').array().$type<SessionRole[]>().notNull(),
    refreshTokenCiphertext: bytea('refresh_token_ciphertext').notNull(),
    refreshTokenIv: bytea('refresh_token_iv').notNull(),
    refreshTokenTag: bytea('refresh_token_tag').notNull(),
    keycloakSessionId: text('keycloak_session_id'),
    createdAt: instant('created_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    idleExpiresAt: instant('idle_expires_at').notNull(),
    absoluteExpiresAt: instant('absolute_expires_at').notNull(),
  },
  (t) => [
    check('session_id_hash_is_sha256', sql`octet_length(${t.idHash}) = 32`),
    check('session_refresh_token_iv_is_96_bit', sql`octet_length(${t.refreshTokenIv}) = 12`),
    check('session_refresh_token_tag_is_128_bit', sql`octet_length(${t.refreshTokenTag}) = 16`),
    check('session_roles_known', sql`${t.roles} <@ ARRAY['reader', 'report_admin']::text[]`),
    check('session_last_seen_in_lifetime', sql`${t.lastSeenAt} >= ${t.createdAt}`),
    check(
      'session_absolute_at_most_8h',
      sql`${t.absoluteExpiresAt} > ${t.createdAt} AND ${t.absoluteExpiresAt} <= ${t.createdAt} + interval '8 hours'`,
    ),
    check(
      'session_idle_at_most_15m',
      sql`${t.idleExpiresAt} > ${t.lastSeenAt} AND ${t.idleExpiresAt} <= ${t.lastSeenAt} + interval '15 minutes' AND ${t.idleExpiresAt} <= ${t.absoluteExpiresAt}`,
    ),
    index('session_idle_expires_at_idx').on(t.idleExpiresAt),
    index('session_absolute_expires_at_idx').on(t.absoluteExpiresAt),
  ],
)

export const AUDIT_EVENT_TYPES = ['access_denied', 'sign_in', 'sign_in_failed', 'sign_out', 'session_expired'] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

/* Append-only and hash-chained: the audit_event_chain trigger (migration 0001) assigns id,
 * prev_hash and hash under a lock; UPDATE, DELETE and TRUNCATE are rejected by trigger. */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: instant('occurred_at').notNull(),
    eventType: text('event_type').$type<AuditEventType>().notNull(),
    actor: text('actor').notNull(),
    traceId: text('trace_id').notNull(),
    detail: jsonb('detail').$type<Record<string, string | number | boolean>>(),
    prevHash: bytea('prev_hash').notNull().unique('audit_event_prev_hash_unique'),
    hash: bytea('hash').notNull(),
  },
  (t) => [
    check(
      'audit_event_type_known',
      sql`${t.eventType} IN ('access_denied', 'sign_in', 'sign_in_failed', 'sign_out', 'session_expired')`,
    ),
    check('audit_event_actor_present', sql`length(${t.actor}) > 0`),
    check('audit_event_trace_id_w3c', sql`${t.traceId} ~ '^[0-9a-f]{32}$'`),
    check('audit_event_hash_is_sha256', sql`octet_length(${t.prevHash}) = 32 AND octet_length(${t.hash}) = 32`),
    index('audit_event_occurred_at_idx').on(t.occurredAt),
  ],
)
