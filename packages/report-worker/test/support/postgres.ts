import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import type { Db } from '../../src/index.js'

export const databaseUrl = process.env.AGENTX_TEST_DATABASE_URL

/* A fresh schema per suite, holding the report tables, reached through the same executeSql
 * shape pg-boss's getDb() gives the worker in production. */
export async function reportSchema() {
  const schema = `report_worker_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  await pool.query(await readFile(new URL('../fixtures/report-schema.sql', import.meta.url), 'utf8'))
  const db: Db = { executeSql: (text, values) => pool.query(text, values) }
  return {
    schema,
    db,
    pool,
    async drop() {
      await pool.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    },
  }
}
