import pg from 'pg'
import { runMigrations } from '../migrate.js'

/* Integration tests run against the disposable PostgreSQL the sandbox provides and skip cleanly without it. */
export const databaseUrl = process.env.AGENTX_TEST_DATABASE_URL
export const noDatabase = !databaseUrl

export async function migratedPool(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  await runMigrations(pool)
  return pool
}

/* Runs fn inside a transaction as one of the application roles, then rolls back. */
export async function asRole<T>(pool: pg.Pool, role: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(role)}`)
    return await fn(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

/* Resolves to the SQLSTATE the statement failed with, or null when it succeeded. */
export async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
}
