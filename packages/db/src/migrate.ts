import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type pg from 'pg'
import { connect } from './client.js'

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

/* Applies the committed forward-only migrations. A session advisory lock serialises concurrent runners
 * (several tasks starting at once), so each migration is applied exactly once. */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('signin_reports_migrations'))")
    try {
      await migrate(connect(client), { migrationsFolder })
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('signin_reports_migrations'))")
    }
  } finally {
    client.release()
  }
}
