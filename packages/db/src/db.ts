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

/** A failed query reduced to what is safe to log: the Postgres SQLSTATE, constraint and table.
 * The pg error's message, detail and where (which quote row values) and the bound parameters
 * (session hashes, ciphertext, account names) are dropped. */
export class DatabaseQueryError extends Error {
  override readonly name = 'DatabaseQueryError'
  readonly code: string | undefined
  readonly constraint: string | undefined
  readonly table: string | undefined

  constructor(code: string | undefined, constraint: string | undefined, table: string | undefined) {
    super('database query failed')
    this.code = code
    this.constraint = constraint
    this.table = table
  }
}

const stringField = (source: unknown, key: 'code' | 'constraint' | 'table'): string | undefined => {
  const value = typeof source === 'object' && source !== null ? (source as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value : undefined
}

/** Rethrows a failed query as a DatabaseQueryError, so neither the SQL text, the row text nor the
 * bound parameters travel up into logs or responses. */
export async function withoutQueryText<T>(query: PromiseLike<T>): Promise<T> {
  try {
    return await query
  } catch (error) {
    const pgError = error instanceof DrizzleQueryError ? error.cause : error
    throw new DatabaseQueryError(
      stringField(pgError, 'code'),
      stringField(pgError, 'constraint'),
      stringField(pgError, 'table'),
    )
  }
}
