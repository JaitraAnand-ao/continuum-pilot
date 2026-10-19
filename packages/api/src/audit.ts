/* The audit port: access denials and failed sign-ins are recorded with the trace that caused them. */
export type AuditEvent =
  | { type: 'access-denied'; account: string; route: string; traceId: string; at: Date }
  | { type: 'sign-in-failed'; errorCode: string; reference: string; traceId: string; at: Date }

export interface AuditSink {
  record(event: AuditEvent): Promise<void>
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = []

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }
}
