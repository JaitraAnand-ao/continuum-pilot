/* The audit port. Access denials are recorded with the account, the route pattern and the trace, nothing more. */
import type { Role } from './access.js'

export interface AccessDeniedEvent {
  type: 'access-denied'
  account: string
  roles: Role[]
  method: string
  route: string
  traceId: string
  at: Date
}

export type AuditEvent = AccessDeniedEvent

export interface AuditSink {
  record(event: AuditEvent): Promise<void>
}

/** For tests and local runs; the hash-chained audit table arrives with CMP-5. */
export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = []

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }
}
