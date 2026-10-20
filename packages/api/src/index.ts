/* CMP-2: BFF serving /api/v1, /auth and the SPA assets. AD-3 fixes packages/api/openapi.json, generated from the route schemas. */
export { buildApp, LOGIN_COOKIE, SESSION_COOKIE, type AppDeps, type RequiredRole } from './app.js'
export {
  InMemoryAuditLog,
  type AuditEvent,
  type AuditLog,
  type ConfigAppliedEvent,
  type RecipientAuditTrail,
} from './audit.js'
export { createOidcClient, OidcRejectedError, OidcUnavailableError, type OidcClient } from './auth/oidc.js'
export { ROLES, type Role } from './auth/roles.js'
export { systemClock, type Clock } from './clock.js'
export {
  buildHistory,
  filterHistory,
  historyRange,
  type DayStatus,
  type History,
  type HistoryDay,
} from './history/rules.js'
export type { ReportHistoryStore, StoredDays, StoredReportSummary } from './history/store.js'
export { loadConfig, Secret, type Config } from './config.js'
export {
  DirectoryUnavailableError,
  InMemoryMetrics,
  InMemoryRecipientStore,
  RecipientAlreadyListedError,
  type DirectoryEntry,
  type DirectoryPort,
  type MetricsPort,
  type Recipient,
  type RecipientStore,
} from './recipients/ports.js'
export { InMemorySessionStore, type SessionRecord, type SessionStore } from './session/store.js'
export * from './settings/rules.js'
export {
  InMemoryDetectionSettingsStore,
  InMemoryTenantAppDirectory,
  type DetectionSettingsStore,
  type TenantApp,
  type TenantAppDirectory,
} from './settings/store.js'
