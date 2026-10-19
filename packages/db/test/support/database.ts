/* Each test file gets its own throwaway database on the disposable server, so files run
 * in parallel without sharing migrations or rows. The roles come from docker-init, exactly
 * as the compose postgres service creates them. */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from '../../src/migrate.js'
import * as schema from '../../src/schema.js'

export const databaseUrl = process.env.AGENTX_TEST_DATABASE_URL

export type Db = NodePgDatabase<typeof schema>

export interface TestDatabase {
  pool: pg.Pool
  db: Db
  /** Runs fn on one connection switched to the given database role. */
  asRole<T>(role: string, fn: (db: Db, client: pg.PoolClient) => Promise<T>): Promise<T>
  drop(): Promise<void>
}

const rolesSql = () => readFile(new URL('../../docker-init/01-roles.sql', import.meta.url), 'utf8')

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!databaseUrl) throw new Error('AGENTX_TEST_DATABASE_URL is not set')
  const name = `sr_test_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: databaseUrl })
  await admin.connect()
  try {
    await admin.query(await rolesSql())
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  const db = drizzle(pool, { schema })
  await migrate(db)

  return {
    pool,
    db,
    async asRole(role, fn) {
      const client = await pool.connect()
      try {
        await client.query(`SET ROLE ${role}`)
        return await fn(drizzle(client, { schema }), client)
      } finally {
        await client.query('RESET ROLE').catch(() => undefined)
        client.release()
      }
    },
    async drop() {
      await pool.end()
      const cleanup = new pg.Client({ connectionString: databaseUrl })
      await cleanup.connect()
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await cleanup.end()
      }
    },
  }
}

/** The Postgres SQLSTATE of a rejected query, read through drizzle's wrapping. */
export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    let current: unknown = error
    while (current && typeof current === 'object') {
      if ('code' in current && typeof current.code === 'string') return current.code
      current = 'cause' in current ? current.cause : undefined
    }
    throw error
  }
  return undefined
}

export const fixedClock = (iso: string) => {
  let current = new Date(iso)
  return {
    now: () => new Date(current),
    set(next: Date | string) {
      current = new Date(next)
    },
  }
}
