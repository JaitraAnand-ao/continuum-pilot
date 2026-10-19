/* Audit port for access decisions. The durable, hash-chained sink belongs to CMP-5; the BFF writes through this port. */
export interface AccessDeniedEvent {
  type: 'access.denied'
  account: string
  method: string
  route: string
  traceId: string
  at: Date
}

export interface AuditSink {
  record(event: AccessDeniedEvent): Promise<void>
}

export interface MemoryAuditSink extends AuditSink {
  readonly events: AccessDeniedEvent[]
}

export function createMemoryAuditSink(): MemoryAuditSink {
  const events: AccessDeniedEvent[] = []
  return {
    events,
    async record(event) {
      events.push(event)
    },
  }
}
