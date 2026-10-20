import { asc, eq, sql } from 'drizzle-orm'
import { guarded, type Database } from './client.js'
import { auditEvents, emailRecipients, type RecipientKind, type RecipientStatus } from './schema.js'

export interface RecipientActor {
  oid: string
  name: string
}

/* Who made the change and when, from the caller's injected Clock, under the request's trace. */
export interface RecipientChange {
  actor: RecipientActor
  traceId: string
  occurredAt: Date
}

/* A recipient that passed the reader-group check; a group carries its member count, a person none. */
export interface NewRecipient {
  kind: RecipientKind
  entraObjectId: string
  displayName: string
  address: string
  memberCount: number | null
}

export interface EmailRecipient extends NewRecipient {
  id: string
  status: RecipientStatus
  addedBy: RecipientActor
  proposedAt: Date
  approvedBy: RecipientActor | null
  approvedAt: Date | null
}

export interface RecipientStore {
  /* Every recipient, active or waiting for approval, by name regardless of case. */
  list(): Promise<EmailRecipient[]>
  /* Stores the recipient waiting for approval and audits the proposal in one transaction. A directory object
   * already listed is handed back unchanged and nothing is audited. */
  propose(
    recipient: NewRecipient,
    change: RecipientChange,
  ): Promise<{ outcome: 'proposed' | 'already_listed'; recipient: EmailRecipient }>
  /* Deletes the recipient at once, without approval, and audits the removal in one transaction. */
  remove(
    id: string,
    change: RecipientChange,
  ): Promise<{ outcome: 'removed'; recipient: EmailRecipient } | { outcome: 'not_found' }>
}

type Row = typeof emailRecipients.$inferSelect

const toRecipient = (row: Row): EmailRecipient => ({
  id: row.id,
  kind: row.kind,
  entraObjectId: row.entraObjectId,
  displayName: row.displayName,
  address: row.address,
  memberCount: row.memberCount,
  status: row.status,
  addedBy: { oid: row.addedByOid, name: row.addedByName },
  proposedAt: row.proposedAt,
  approvedBy:
    row.approvedByOid !== null && row.approvedByName !== null
      ? { oid: row.approvedByOid, name: row.approvedByName }
      : null,
  approvedAt: row.approvedAt,
})

/* The audit target names the directory object, so the trail carries no address of its own. */
const auditTarget = (entraObjectId: string) => `email_recipient/${entraObjectId}`

type Executor = Pick<Database, 'insert'>

async function audit(
  tx: Executor,
  type: 'recipient.proposed' | 'recipient.removed',
  entraObjectId: string,
  change: RecipientChange,
): Promise<void> {
  /* prev_hash and hash are written by the chaining trigger. */
  await tx.insert(auditEvents).values({
    occurredAt: change.occurredAt,
    eventType: type,
    actorOid: change.actor.oid,
    actorName: change.actor.name,
    target: auditTarget(entraObjectId),
    traceId: change.traceId,
    hash: Buffer.alloc(0),
  })
}

export function createRecipientStore(db: Database): RecipientStore {
  return guarded({
    async list() {
      const rows = await db
        .select()
        .from(emailRecipients)
        .orderBy(sql`lower(${emailRecipients.displayName})`, asc(emailRecipients.id))
      return rows.map(toRecipient)
    },

    async propose(recipient: NewRecipient, change: RecipientChange) {
      /* A listed row removed between the conflicting insert and its read leaves nothing to hand back; the
       * proposal is then simply tried again, now with the object no longer listed. */
      for (;;) {
        const result = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(emailRecipients)
            .values({
              ...recipient,
              status: 'pending_approval',
              addedByOid: change.actor.oid,
              addedByName: change.actor.name,
              proposedAt: change.occurredAt,
            })
            .onConflictDoNothing({ target: emailRecipients.entraObjectId })
            .returning()
          if (inserted === undefined) {
            const [existing] = await tx
              .select()
              .from(emailRecipients)
              .where(eq(emailRecipients.entraObjectId, recipient.entraObjectId))
            return existing && { outcome: 'already_listed' as const, recipient: toRecipient(existing) }
          }
          await audit(tx, 'recipient.proposed', recipient.entraObjectId, change)
          return { outcome: 'proposed' as const, recipient: toRecipient(inserted) }
        })
        if (result) return result
      }
    },

    async remove(id: string, change: RecipientChange) {
      return db.transaction(async (tx) => {
        const [removed] = await tx.delete(emailRecipients).where(eq(emailRecipients.id, id)).returning()
        if (removed === undefined) return { outcome: 'not_found' as const }
        await audit(tx, 'recipient.removed', removed.entraObjectId, change)
        return { outcome: 'removed' as const, recipient: toRecipient(removed) }
      })
    },
  })
}
