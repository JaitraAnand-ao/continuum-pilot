/* The append-only audit log. The database assigns id, prev_hash and hash (trigger
 * audit_events_chain); verifyAuditChain recomputes the chain independently. */
import { createHash } from 'node:crypto'
import { asc } from 'drizzle-orm'
import { withoutQueryText, type Database } from './db.js'
import { auditEvents, type AuditEventType } from './schema.js'

export interface AuditEventInput {
  occurredAt: Date
  eventType: AuditEventType
  /** Entra object ID of the account, or null when sign-in failed before one was known. */
  subject: string | null
  /** A code (e.g. missing_reader_role, AADSTS50126), never free text. */
  reason: string | null
  traceId: string
}

export type AuditRow = Pick<
  typeof auditEvents.$inferSelect,
  'id' | 'occurredAt' | 'eventType' | 'subject' | 'reason' | 'traceId' | 'prevHash' | 'hash'
>

export interface AuditLog {
  append(event: AuditEventInput): Promise<{ id: number }>
}

export function createAuditLog(db: Database): AuditLog {
  return {
    async append(event) {
      const [row] = await withoutQueryText(db.insert(auditEvents).values(event).returning({ id: auditEvents.id }))
      return { id: (row as { id: number }).id }
    },
  }
}

/** Reads the whole chain in order. Needs SELECT on audit_events, which no runtime role holds. */
export async function readAuditChain(db: Database): Promise<AuditRow[]> {
  return withoutQueryText(db.select().from(auditEvents).orderBy(asc(auditEvents.id)))
}

const field = (value: string | null): Buffer => {
  if (value === null) return Buffer.from('-')
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
}

/** Mirrors audit_event_digest in migrations/0001; change both or neither. */
export function auditEventDigest(prevHash: Buffer | null, row: Omit<AuditRow, 'prevHash' | 'hash'>): Buffer {
  return createHash('sha256')
    .update(prevHash === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), prevHash]))
    .update(field(String(row.id)))
    .update(field(row.occurredAt.toISOString()))
    .update(field(row.eventType))
    .update(field(row.subject))
    .update(field(row.reason))
    .update(field(row.traceId))
    .digest()
}

export type ChainVerdict = { ok: true; length: number } | { ok: false; brokenAt: number }

/** Checks each row links to the one before it and that its hash matches its contents. */
export function verifyAuditChain(rows: readonly AuditRow[]): ChainVerdict {
  let previous: Buffer | null = null
  for (const row of rows) {
    const linked = previous === null ? row.prevHash === null : row.prevHash !== null && row.prevHash.equals(previous)
    if (!linked || !auditEventDigest(row.prevHash, row).equals(row.hash)) return { ok: false, brokenAt: row.id }
    previous = row.hash
  }
  return { ok: true, length: rows.length }
}
