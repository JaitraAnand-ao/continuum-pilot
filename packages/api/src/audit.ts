/* Access-denied audit events (ST-1 AC-5, AC-7). The port is what routes depend on; the Postgres sink lands with CMP-5. */
import type { Role } from './auth/roles.js'

export interface AccessDeniedEvent {
  type: 'access-denied'
  account: string
  reason: 'no-role' | 'missing-role' | 'route-undeclared'
  requiredRole?: Role
  route: string
  traceId: string
  at: string
}

export type AuditEvent = AccessDeniedEvent

export interface AuditLog {
  record(event: AuditEvent): Promise<void>
}

export class InMemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = []
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }
}
