/* Test support: the disposable PostgreSQL from AGENTX_TEST_DATABASE_URL, migrated once per file. */
import pg from 'pg'
import { migrateDatabase } from './migrate.js'
import type { Clock } from './clock.js'

export const testDatabaseUrl = process.env['AGENTX_TEST_DATABASE_URL']

/* Bounds on every test connection: an unreachable server or a stuck lock fails the run fast
 * instead of holding CI open until it is killed. */
export const TEST_CONNECT_TIMEOUT_MS = 5_000
export const TEST_STATEMENT_TIMEOUT_MS = 30_000

function testPool(url: string, settings = ''): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: TEST_CONNECT_TIMEOUT_MS,
    options: `-c statement_timeout=${TEST_STATEMENT_TIMEOUT_MS}${settings}`,
  })
}

export async function migratedOwnerPool(url: string): Promise<pg.Pool> {
  const pool = testPool(url)
  try {
    await migrateDatabase(pool)
  } catch (error) {
    await pool.end()
    throw error
  }
  return pool
}

/** A pool whose every connection runs as the given group role, proving the grants suffice. */
export function poolAs(url: string, role: string): pg.Pool {
  return testPool(url, ` -c role=${role}`)
}

export class FixedClock implements Clock {
  constructor(private instant: Date) {}
  now(): Date {
    return new Date(this.instant.getTime())
  }
  set(instant: Date): void {
    this.instant = instant
  }
  advance(ms: number): void {
    this.instant = new Date(this.instant.getTime() + ms)
  }
}
