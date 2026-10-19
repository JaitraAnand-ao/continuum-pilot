/* CMP-5 Drizzle schema. Every change here ships with its generated migration in ../migrations;
 * grants, triggers and CHECKs drizzle-kit cannot express live in the custom migrations beside it. */
import { sql } from 'drizzle-orm'
import { bigint, check, customType, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })
const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' })

export const APP_ROLES = ['reader', 'admin'] as const
export type AppRole = (typeof APP_ROLES)[number]

export const AUDIT_EVENT_TYPES = ['sign_in', 'sign_in_failed', 'access_denied', 'sign_out', 'session_expired'] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

export const sessions = pgTable(
  'sessions',
  {
    idHash: bytea('id_hash').primaryKey(),
    subject: text('subject').notNull(),
    username: text('username').notNull(),
    roles: text('roles').array().notNull().$type<AppRole[]>(),
    refreshTokenCiphertext: bytea('refresh_token_ciphertext').notNull(),
    refreshTokenIv: bytea('refresh_token_iv').notNull(),
    refreshTokenTag: bytea('refresh_token_tag').notNull(),
    idpSessionId: text('idp_session_id').notNull(),
    createdAt: instant('created_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    absoluteExpiresAt: instant('absolute_expires_at').notNull(),
  },
  (t) => [
    check('sessions_id_hash_sha256', sql`octet_length(${t.idHash}) = 32`),
    check(
      'sessions_refresh_token_gcm',
      sql`octet_length(${t.refreshTokenIv}) = 12 and octet_length(${t.refreshTokenTag}) = 16`,
    ),
    check('sessions_roles_known', sql`${t.roles} <@ array['reader', 'admin']::text[]`),
    check('sessions_absolute_8h', sql`${t.absoluteExpiresAt} <= ${t.createdAt} + interval '8 hours'`),
    check('sessions_last_seen_after_created', sql`${t.lastSeenAt} >= ${t.createdAt}`),
    index('sessions_last_seen_at_idx').on(t.lastSeenAt),
    index('sessions_absolute_expires_at_idx').on(t.absoluteExpiresAt),
  ],
)

export const loginTransactions = pgTable(
  'login_transactions',
  {
    idHash: bytea('id_hash').primaryKey(),
    stateHash: bytea('state_hash').notNull(),
    nonceHash: bytea('nonce_hash').notNull(),
    codeVerifierCiphertext: bytea('code_verifier_ciphertext').notNull(),
    codeVerifierIv: bytea('code_verifier_iv').notNull(),
    codeVerifierTag: bytea('code_verifier_tag').notNull(),
    expiresAt: instant('expires_at').notNull(),
  },
  (t) => [
    check(
      'login_transactions_hashes_sha256',
      sql`octet_length(${t.idHash}) = 32 and octet_length(${t.stateHash}) = 32 and octet_length(${t.nonceHash}) = 32`,
    ),
    check(
      'login_transactions_verifier_gcm',
      sql`octet_length(${t.codeVerifierIv}) = 12 and octet_length(${t.codeVerifierTag}) = 16`,
    ),
    index('login_transactions_expires_at_idx').on(t.expiresAt),
  ],
)

/* Append-only: position, prev_hash and hash are set by the chain trigger, never by the caller. */
export const auditEvents = pgTable(
  'audit_events',
  {
    position: bigint('position', { mode: 'bigint' }).primaryKey(),
    occurredAt: instant('occurred_at').notNull(),
    eventType: text('event_type').notNull().$type<AuditEventType>(),
    subject: text('subject'),
    username: text('username'),
    traceId: text('trace_id').notNull(),
    detail: jsonb('detail').notNull().$type<Record<string, string>>().default({}),
    prevHash: bytea('prev_hash').notNull(),
    hash: bytea('hash').notNull(),
  },
  (t) => [
    check(
      'audit_events_type_known',
      sql`${t.eventType} in ('sign_in', 'sign_in_failed', 'access_denied', 'sign_out', 'session_expired')`,
    ),
    check('audit_events_trace_id_w3c', sql`${t.traceId} ~ '^[0-9a-f]{32}$'`),
    index('audit_events_subject_idx').on(t.subject),
    index('audit_events_occurred_at_idx').on(t.occurredAt),
  ],
)
