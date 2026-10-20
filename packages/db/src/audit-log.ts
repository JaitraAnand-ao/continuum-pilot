import { sql } from 'drizzle-orm'
import { guarded, type Database } from './client.js'
import { auditEvents, type AuditEventType } from './schema.js'

export interface AuditEvent {
  type: AuditEventType
  actorOid: string | null
  actorName: string | null
  /* The route template or resource named, never a raw URL with its query. */
  target: string | null
  traceId: string
  occurredAt: Date
}

export interface AuditLog {
  record(event: AuditEvent): Promise<{ id: number }>
}

export function createAuditLog(db: Database): AuditLog {
  return guarded({
    async record(event) {
      /* prev_hash and hash are written by the chaining trigger, so the insert leaves them to it. */
      const { rows } = await db.execute<{ id: string }>(sql`
        INSERT INTO ${auditEvents} (occurred_at, event_type, actor_oid, actor_name, target, trace_id, hash)
        VALUES (${event.occurredAt.toISOString()}, ${event.type}, ${event.actorOid}, ${event.actorName},
                ${event.target}, ${event.traceId}, '\\x'::bytea)
        RETURNING id`)
      return { id: Number(rows[0]?.id) }
    },
  })
}

/* Id of the first audit event whose chain link or hash fails to verify, or null when the chain holds. */
export async function findAuditChainBreak(db: Database): Promise<number | null> {
  const { rows } = await db.execute<{ id: string | null }>(sql`SELECT audit_chain_break() AS id`)
  const id = rows[0]?.id
  return id === null || id === undefined ? null : Number(id)
}
