import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import * as schema from './schema.js'

export type Database = NodePgDatabase<typeof schema>

/** Runtime roles created and granted by the committed migrations (AD-10). */
export const DB_ROLES = {
  api: 'sr_api',
  reportWorker: 'sr_report_worker',
  mailWorker: 'sr_mail_worker',
} as const

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema })
}

/** Applies the committed forward-only migrations; run as the migrator, never by a runtime role. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder })
}

/** Rethrows a failed query as the underlying Postgres error, so neither the SQL text nor the
 * bound parameters (session hashes, ciphertext) travel up into logs or responses. */
export async function withoutQueryText<T>(query: PromiseLike<T>): Promise<T> {
  try {
    return await query
  } catch (error) {
    throw error instanceof DrizzleQueryError && error.cause instanceof Error ? error.cause : error
  }
}
