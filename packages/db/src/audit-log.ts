/* The append-only audit log. The database assigns id, prev_hash and hash (trigger
 * audit_event_chain); this module only appends and asks the database to verify the chain. */
import { sql } from 'drizzle-orm'
import type { Db } from './db.js'
import type { Clock } from './clock.js'
import { auditEvent, type AuditEventType } from './schema.js'

export { AUDIT_EVENT_TYPES, type AuditEventType } from './schema.js'

export interface AuditEventInput {
  type: AuditEventType
  /** The account the event is about, e.g. the signed-in UPN on access_denied. */
  actor: string
  /** The W3C trace ID of the request that caused the event. */
  traceId: string
  /** Codes only, never tokens or report data. */
  detail?: Record<string, string | number | boolean>
}

export async function recordAuditEvent(
  db: Db,
  clock: Clock,
  input: AuditEventInput,
): Promise<{ id: number; hash: Buffer }> {
  const [row] = await db
    .insert(auditEvent)
    .values({
      occurredAt: clock.now(),
      eventType: input.type,
      actor: input.actor,
      traceId: input.traceId,
      detail: input.detail ?? null,
      /* Placeholders: the chain trigger overwrites both. */
      prevHash: Buffer.alloc(32),
      hash: Buffer.alloc(32),
    })
    .returning({ id: auditEvent.id, hash: auditEvent.hash })
  if (!row) throw new Error('audit_event insert returned no row')
  return row
}

export type AuditChainVerdict = { valid: true } | { valid: false; brokenAtId: number }

export async function verifyAuditChain(db: Db): Promise<AuditChainVerdict> {
  const { rows } = await db.execute<{ broken: string | null }>(sql`SELECT audit_event_first_broken() AS broken`)
  const broken = rows[0]?.broken
  return broken == null ? { valid: true } : { valid: false, brokenAtId: Number(broken) }
}
