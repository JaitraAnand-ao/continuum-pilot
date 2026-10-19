import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

/** A drizzle node-postgres database, whatever relational schema the caller bound to it. */
export type Db = NodePgDatabase<Record<string, unknown>>
