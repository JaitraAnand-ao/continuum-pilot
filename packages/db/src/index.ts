/* CMP-5: Drizzle schema, committed forward-only migrations at packages/db/migrations (AD-10), per-role grants. */
export * from './schema.js'
export type { Clock } from './clock.js'
export type { Db } from './db.js'
export * from './session-store.js'
export { recordAuditEvent, verifyAuditChain, type AuditEventInput, type AuditChainVerdict } from './audit-log.js'
export { migrate, migrationsFolder } from './migrate.js'
