/* CMP-5: Drizzle schema, committed forward-only migrations at packages/db/migrations (AD-10), per-role grants. */
export { connect, type Database } from './client.js'
export { migrationsFolder, runMigrations } from './migrate.js'
export * from './schema.js'
export * from './session-store.js'
export * from './audit-log.js'
export * from './report-reader.js'
