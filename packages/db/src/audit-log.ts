/* Sign-in audit events (AC-5 access denied, AC-6 failed sign-in). Only IDs and short codes
 * are stored: the reason is a code such as an Entra AADSTS error, never free text. */
import type { Queryable } from './queryable.js'

export const AUDIT_EVENT_TYPES = ['access_denied', 'sign_in', 'sign_in_failed', 'sign_out', 'session_expired'] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

export interface AuditEvent {
  occurredAt: Date
  type: AuditEventType
  /** Entra object ID of the account, when one is known. */
  actorOid: string | null
  /** W3C trace ID of the request that caused the event. */
  traceId: string
  reason: string | null
}

const TRACE_ID = /^[0-9a-f]{32}$/
const REASON = /^[A-Za-z0-9_.-]{1,64}$/
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const INSERT = `
INSERT INTO audit_event (occurred_at, event_type, actor_oid, trace_id, reason)
VALUES ($1, $2, $3, $4, $5)`

/** Appends an event; the database assigns its sequence number and chains its hash. */
export async function recordAuditEvent(db: Queryable, event: AuditEvent): Promise<void> {
  if (!(AUDIT_EVENT_TYPES as readonly string[]).includes(event.type)) {
    throw new Error(`unknown audit event type ${event.type}`)
  }
  if (!TRACE_ID.test(event.traceId)) throw new Error('trace ID must be 32 lowercase hex digits')
  if (event.actorOid !== null && !OBJECT_ID.test(event.actorOid)) throw new Error('actor must be an Entra object ID')
  if (event.reason !== null && !REASON.test(event.reason))
    throw new Error('reason must be a code of at most 64 characters')
  await db.query(INSERT, [event.occurredAt, event.type, event.actorOid, event.traceId, event.reason])
}
