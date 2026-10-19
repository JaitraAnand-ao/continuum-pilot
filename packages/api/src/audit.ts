/* The audit port. Events carry IDs and the account's UPN only; never a token or a cookie value. */
export type AuditEventType = 'session.signed_in' | 'session.signed_out' | 'signin.failed' | 'access.denied'

export interface AuditEvent {
  type: AuditEventType
  at: Date
  traceId: string
  subject?: string
  account?: string
  route?: string
  reason?: string
}

export interface AuditLog {
  record(event: AuditEvent): Promise<void>
}

/* The in-process adapter, used until CMP-5 commits the audit table. */
export class InMemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = []

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }
}
