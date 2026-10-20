import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate.js'
import { databaseUrl, noDatabase } from './db.js'

describe.skipIf(noDatabase)('runMigrations', () => {
  it('is safe to run concurrently and again', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    try {
      await Promise.all([runMigrations(pool), runMigrations(pool)])
      await runMigrations(pool)
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('sessions', 'audit_events')",
      )
      expect(rows[0].n).toBe(2)
    } finally {
      await pool.end()
    }
  })
})
