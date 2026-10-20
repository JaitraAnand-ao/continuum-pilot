import { DrizzleQueryError } from 'drizzle-orm/errors'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type pg from 'pg'
import * as schema from './schema.js'

export type Database = NodePgDatabase<typeof schema>

export function connect(client: pg.Pool | pg.PoolClient | pg.Client): Database {
  return drizzle({ client, schema })
}

/* Drizzle's query error repeats the bound parameters (sealed tokens, account names) in its message; callers get the
 * driver's error instead, which carries the SQLSTATE and constraint but no values. */
export async function withoutParameters<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof DrizzleQueryError && error.cause) throw error.cause
    throw error
  }
}

/* Applies withoutParameters to every method of a store. */
export function guarded<T extends object>(methods: T): T {
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      (...args: unknown[]) => withoutParameters(() => (method as (...a: unknown[]) => Promise<unknown>)(...args)),
    ]),
  ) as T
}
