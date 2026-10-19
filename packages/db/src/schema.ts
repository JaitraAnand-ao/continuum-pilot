/* CMP-5 Drizzle schema. Every change here arrives with its generated migration (AD-10);
 * privileges and triggers live in the custom migrations beside them. The CHECK and index
 * definitions are built at import rather than inside the table callbacks, which only
 * drizzle-kit evaluates, so the tests that load the schema exercise them too. */
import { sql } from 'drizzle-orm'
import { bigint, check, customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3 })

const sessionConstraints = [
  check('session_id_hash_sha256', sql`octet_length("session"."id_hash") = 32`),
  check('session_refresh_token_iv_96_bits', sql`octet_length("session"."refresh_token_iv") = 12`),
  check('session_refresh_token_tag_128_bits', sql`octet_length("session"."refresh_token_tag") = 16`),
  check('session_refresh_token_ciphertext_present', sql`octet_length("session"."refresh_token_ciphertext") > 0`),
  check('session_roles_known', sql`"session"."roles" <@ ARRAY['reader', 'report_admin']::text[]`),
  check(
    'session_absolute_at_most_8_hours',
    sql`"session"."absolute_expires_at" <= "session"."created_at" + interval '8 hours'`,
  ),
  check('session_last_seen_after_created', sql`"session"."last_seen_at" >= "session"."created_at"`),
  check(
    'session_idle_at_most_15_minutes',
    sql`"session"."idle_expires_at" <= least("session"."absolute_expires_at", "session"."last_seen_at" + interval '15 minutes')`,
  ),
  check(
    'session_end_reason_known',
    sql`("session"."ended_at" IS NULL AND "session"."end_reason" IS NULL) OR ("session"."ended_at" IS NOT NULL AND "session"."end_reason" IN ('logout', 'idle', 'absolute', 'rotated'))`,
  ),
]

/* AD-5 server-side session. The browser holds only the __Host-sr_session cookie; this row
 * holds the SHA-256 of that cookie's value and the refresh token as AES-256-GCM parts. */
export const session = pgTable(
  'session',
  {
    idHash: bytea('id_hash').primaryKey(),
    subjectOid: uuid('subject_oid').notNull(),
    accountName: text('account_name').notNull(),
    roles: text('roles').array().notNull(),
    refreshTokenCiphertext: bytea('refresh_token_ciphertext').notNull(),
    refreshTokenIv: bytea('refresh_token_iv').notNull(),
    refreshTokenTag: bytea('refresh_token_tag').notNull(),
    idpSessionId: text('idp_session_id').notNull(),
    createdAt: instant('created_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    idleExpiresAt: instant('idle_expires_at').notNull(),
    absoluteExpiresAt: instant('absolute_expires_at').notNull(),
    endedAt: instant('ended_at'),
    endReason: text('end_reason'),
  },
  (table) => [
    ...sessionConstraints,
    index('session_subject_oid_idx').on(table.subjectOid),
    index('session_absolute_expires_at_idx').on(table.absoluteExpiresAt),
  ],
)

const auditEventConstraints = [
  check(
    'audit_event_type_known',
    sql`"audit_event"."event_type" IN ('access_denied', 'sign_in', 'sign_in_failed', 'sign_out', 'session_expired')`,
  ),
  check('audit_event_trace_id_w3c', sql`"audit_event"."trace_id" ~ '^[0-9a-f]{32}$'`),
  check('audit_event_reason_code', sql`"audit_event"."reason" ~ '^[A-Za-z0-9_.-]{1,64}$'`),
  check(
    'audit_event_hashes_sha256',
    sql`octet_length("audit_event"."prev_hash") = 32 AND octet_length("audit_event"."hash") = 32`,
  ),
]

/* Append-only audit log. seq, prev_hash and hash are set by the audit_event_chain trigger,
 * whatever the caller supplies; UPDATE, DELETE and TRUNCATE are rejected by trigger. */
export const auditEvent = pgTable(
  'audit_event',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey(),
    occurredAt: instant('occurred_at').notNull(),
    eventType: text('event_type').notNull(),
    actorOid: uuid('actor_oid'),
    traceId: text('trace_id').notNull(),
    reason: text('reason'),
    prevHash: bytea('prev_hash').notNull(),
    hash: bytea('hash').notNull().unique('audit_event_hash_unique'),
  },
  (table) => [
    ...auditEventConstraints,
    index('audit_event_actor_oid_idx').on(table.actorOid),
    index('audit_event_occurred_at_idx').on(table.occurredAt),
  ],
)
