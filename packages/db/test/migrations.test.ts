/* migration-committed: the committed, generated migrations build the schema from an empty
 * database and re-running them is a no-op (forward-only, AD-10). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/migrate.js'
import { createTestDatabase, databaseUrl, type TestDatabase } from './support/database.js'

describe.skipIf(!databaseUrl)('committed migrations', () => {
  let t: TestDatabase

  beforeAll(async () => {
    t = await createTestDatabase()
  })
  afterAll(async () => {
    await t?.drop()
  })

  it('create the session and audit_event tables', async () => {
    const { rows } = await t.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )
    expect(rows.map((r) => r.table_name)).toEqual(['audit_event', 'session'])
  })

  it('are recorded once and re-running them changes nothing', async () => {
    const count = async () =>
      (await t.pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n as number
    const before = await count()
    expect(before).toBeGreaterThanOrEqual(2)
    await migrate(t.db)
    expect(await count()).toBe(before)
  })
})
