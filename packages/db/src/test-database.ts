/* Test support: the disposable PostgreSQL from AGENTX_TEST_DATABASE_URL, migrated once per file. */
import pg from 'pg'
import { migrateDatabase } from './migrate.js'
import type { Clock } from './clock.js'

export const testDatabaseUrl = process.env['AGENTX_TEST_DATABASE_URL']

export async function migratedOwnerPool(url: string): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: url, max: 4 })
  await migrateDatabase(pool)
  return pool
}

/** A pool whose every connection runs as the given group role, proving the grants suffice. */
export function poolAs(url: string, role: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 4, options: `-c role=${role}` })
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
