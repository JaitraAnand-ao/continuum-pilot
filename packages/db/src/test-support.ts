/* Test-only: a throwaway database per test file on the disposable AGENTX_TEST_DATABASE_URL server,
 * migrated with the committed migrations. Tests skip cleanly when the variable is unset. */
import { randomBytes } from 'node:crypto'
import pg from 'pg'

export const testDatabaseUrl = process.env['AGENTX_TEST_DATABASE_URL']

export interface FreshDatabase {
  url: string
  pool: pg.Pool
  drop: () => Promise<void>
}

export async function createFreshDatabase(serverUrl: string): Promise<FreshDatabase> {
  const name = `sr_test_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: serverUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(serverUrl)
  url.pathname = `/${name}`
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 })
  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end()
      const cleanup = new pg.Client({ connectionString: serverUrl })
      await cleanup.connect()
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await cleanup.end()
    },
  }
}

/** Runs `work` on one connection acting as `role`, then resets the role. */
export async function asRole<T>(pool: pg.Pool, role: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query(`SET ROLE ${role}`)
    return await work(client)
  } finally {
    await client.query('RESET ROLE')
    client.release()
  }
}

export const sha256Length = (fill: number, length = 32): Buffer => Buffer.alloc(length, fill)
