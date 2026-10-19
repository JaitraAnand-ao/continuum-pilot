import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type pg from 'pg'
import * as schema from './schema.js'

export type Database = NodePgDatabase<typeof schema>

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema })
}

/* Drizzle's query error repeats the bound parameters (usernames, ciphertexts) in its message;
 * rethrow the driver's error instead so no caller can log them by accident. */
export async function withoutParams<T>(query: Promise<T>): Promise<T> {
  try {
    return await query
  } catch (error) {
    throw error instanceof Error && error.cause instanceof Error ? error.cause : error
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any method signature
type AsyncMethods = Record<string, (...args: any[]) => Promise<unknown>>

/** Applies withoutParams to every method of a store. */
export function guarded<T extends AsyncMethods>(methods: T): T {
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [name, (...args: unknown[]) => withoutParams(method(...args))]),
  ) as T
}
