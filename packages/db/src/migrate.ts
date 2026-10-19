import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type pg from 'pg'

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url))

/* Any fixed key: it only has to be the same for every migrator so concurrent runs queue up. */
const MIGRATION_LOCK = 5_000_001

/** Applies the committed forward-only migrations once, safe to run from several processes at once. */
export async function migrateDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK])
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK])
    client.release()
  }
}
