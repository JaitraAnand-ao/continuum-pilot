import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type pg from 'pg'
import * as schema from './schema.js'

export type Database = NodePgDatabase<typeof schema>

export function connect(client: pg.Pool | pg.PoolClient | pg.Client): Database {
  return drizzle({ client, schema })
}
