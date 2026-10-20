/* Access-denied audit events (ST-1 AC-5, AC-7) and config.applied for each detection-settings version (ST-15 AC-3, AC-4). The port is what routes depend on; the Postgres sink lands with CMP-5. */
import type { Role } from './auth/roles.js'
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

export type AuditEvent = AccessDeniedEvent | ConfigAppliedEvent

export interface AuditLog {
  record(event: AuditEvent): Promise<void>
}

export class InMemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = []
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }
}
