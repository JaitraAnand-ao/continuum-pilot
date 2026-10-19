/* The append-only audit log. Position and the SHA-256 chain are assigned by the database
 * trigger, so a caller can neither choose nor skip a link. */
import { sql } from 'drizzle-orm'
import type { Clock } from './clock.js'
import { guarded, withoutParams, type Database } from './database.js'
import { auditEvents, type AuditEventType } from './schema.js'

export interface AuditEvent {
  type: AuditEventType
  subject: string | null
  username: string | null
  traceId: string
  detail?: Record<string, string>
}

export type AuditChainResult = { ok: true; length: number } | { ok: false; length: number; brokenAt: number }

export function createAuditLog(db: Database, clock: Clock) {
  return guarded({
    async record(event: AuditEvent): Promise<void> {
      const a = auditEvents
      await db.execute(sql`
        insert into ${a} (${sql.identifier(a.occurredAt.name)}, ${sql.identifier(a.eventType.name)},
          ${sql.identifier(a.subject.name)}, ${sql.identifier(a.username.name)},
          ${sql.identifier(a.traceId.name)}, ${sql.identifier(a.detail.name)})
        values (${clock.now().toISOString()}::timestamptz, ${event.type}, ${event.subject}, ${event.username},
          ${event.traceId}, ${JSON.stringify(event.detail ?? {})}::jsonb)`)
    },
  })
}

export type AuditLog = ReturnType<typeof createAuditLog>

/** Recomputes every link; needs the sr_auditor grants. */
export async function verifyAuditChain(db: Database): Promise<AuditChainResult> {
  const { rows } = await withoutParams(
    db.execute<{ length: string; broken_at: string | null }>(sql`
    with links as (
      select position,
             row_number() over w as expected_position,
             prev_hash,
             hash,
             coalesce(lag(hash) over w, '\\x0000000000000000000000000000000000000000000000000000000000000000'::bytea)
               as expected_prev,
             audit_event_digest(prev_hash, position, occurred_at, event_type, subject, username, trace_id, detail)
               as expected_hash
        from audit_events
      window w as (order by position)
    )
    select count(*) as length,
           min(position) filter (where position <> expected_position
                                    or prev_hash <> expected_prev
                                    or hash <> expected_hash) as broken_at
      from links`),
  )
  const length = Number(rows[0]?.length ?? 0)
  const brokenAt = rows[0]?.broken_at
  return brokenAt == null ? { ok: true, length } : { ok: false, length, brokenAt: Number(brokenAt) }
}
