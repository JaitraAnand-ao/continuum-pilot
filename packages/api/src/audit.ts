/* Access-denied audit events (ST-1 AC-5, AC-7), config.applied for each detection-settings version (ST-15 AC-3, AC-4)
 * and every recipient check, proposal and removal (ST-18 AC-5, AC-10). The ports are what routes depend on; the Postgres sink lands with CMP-5. */
import type { Role } from './auth/roles.js'
import type { Verdict } from './recipients/rules.js'
import type { Threshold, ThresholdKey } from './settings/rules.js'

export interface AccessDeniedEvent {
  type: 'access-denied'
  account: string
  reason: 'no-role' | 'missing-role' | 'route-undeclared'
  requiredRole?: Role
  route: string
  traceId: string
  at: string
}

/* Names who applied the version; the change carries settings and application names only, never sign-in data. */
export interface ConfigAppliedEvent {
  type: 'config.applied'
  account: string
  configVersionId: string
  previousConfigVersionId: string
  change:
    | { setting: ThresholdKey; from: Threshold; to: Threshold }
    | { setting: 'sensitive_apps'; added: { appId: string; appName: string } }
  traceId: string
  at: string
}

/* Names the administrator and the directory id acted on, never the recipient's address. */
export interface RecipientEvent {
  type:
    'recipient.checked' | 'recipient.check_failed' | 'recipient.proposed' | 'recipient.removed' | 'recipient.withdrawn'
  account: string
  target: string
  outcome?: Verdict
  traceId: string
  at: string
}

export type AuditEvent = AccessDeniedEvent | ConfigAppliedEvent | RecipientEvent

export interface AuditLog {
  record(event: AuditEvent): Promise<void>
}

/* IF-56 reads the recipient events back, newest first. */
export interface RecipientAuditTrail {
  recipientEvents(): Promise<RecipientEvent[]>
}

export class InMemoryAuditLog implements AuditLog, RecipientAuditTrail {
  readonly events: AuditEvent[] = []
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }
  async recipientEvents(): Promise<RecipientEvent[]> {
    return this.events.filter((event): event is RecipientEvent => event.type.startsWith('recipient.')).reverse()
  }
}
