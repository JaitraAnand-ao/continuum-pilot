/* Independent check of the chain the audit_event_chain trigger writes: each hash is
 * SHA-256(prev_hash || seq|occurred_at|event_type|actor_oid|trace_id|reason), with the
 * instant in UTC to the microsecond and absent values as empty strings. */
import { createHash } from 'node:crypto'
import type { AuditEvent } from './audit-log.js'

export const AUDIT_GENESIS_HASH: Buffer = Buffer.alloc(32)

export interface StoredAuditEntry extends AuditEvent {
  seq: number
  prevHash: Buffer
  hash: Buffer
}

export type AuditChainVerdict = { ok: true; entries: number } | { ok: false; brokenAtSeq: number }

export function auditEntryHash(prevHash: Buffer, entry: AuditEvent & { seq: number }): Buffer {
  const occurredAt = entry.occurredAt.toISOString().replace('Z', '000Z')
  const payload = [entry.seq, occurredAt, entry.type, entry.actorOid ?? '', entry.traceId, entry.reason ?? ''].join('|')
  return createHash('sha256').update(prevHash).update(payload, 'utf8').digest()
}

/** Walks entries in sequence order from the genesis hash; reports the first that does not link. */
export function verifyAuditChain(entries: readonly StoredAuditEntry[]): AuditChainVerdict {
  let prev = AUDIT_GENESIS_HASH
  for (const entry of entries) {
    if (!entry.prevHash.equals(prev) || !entry.hash.equals(auditEntryHash(prev, entry))) {
      return { ok: false, brokenAtSeq: entry.seq }
    }
    prev = entry.hash
  }
  return { ok: true, entries: entries.length }
}
