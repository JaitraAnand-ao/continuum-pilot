import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type pg from 'pg'
import * as schema from './schema.js'

export type Database = NodePgDatabase<typeof schema>

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema })
}

/* Fixed wording per SQLSTATE: says what kind of refusal it was without quoting a single value. */
const REFUSALS: Record<string, string> = {
  '42501': 'permission denied',
  '23502': 'not-null constraint violated',
  '23505': 'unique constraint violated',
  '23514': 'check constraint violated',
}

/** What survives of a failed query: the SQLSTATE and the schema object it names, never values. */
export class DatabaseError extends Error {
  readonly code: string | undefined
  readonly constraint: string | undefined
  readonly table: string | undefined
  readonly column: string | undefined

  constructor(fields: {
    code: string | undefined
    constraint: string | undefined
    table: string | undefined
    column: string | undefined
  }) {
    const refusal = fields.code === undefined ? undefined : REFUSALS[fields.code]
    super(refusal === undefined ? 'database query failed' : `database query failed: ${refusal}`)
    this.name = 'DatabaseError'
    this.code = fields.code
    this.constraint = fields.constraint
    this.table = fields.table
    this.column = fields.column
  }
}

/* Drizzle's query error repeats the bound parameters (usernames, ciphertexts) in its message, and
 * the driver's error carries them in detail and where; rethrow only the code and the object names
 * so no caller can log them by accident. */
export async function withoutParams<T>(query: Promise<T>): Promise<T> {
  try {
    return await query
  } catch (error) {
    const driver = (error instanceof Error && error.cause instanceof Error ? error.cause : error) as Record<
      string,
      unknown
    >
    const field = (name: string) => (typeof driver?.[name] === 'string' ? (driver[name] as string) : undefined)
    throw new DatabaseError({
      code: field('code'),
      constraint: field('constraint'),
      table: field('table'),
      column: field('column'),
    })
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
