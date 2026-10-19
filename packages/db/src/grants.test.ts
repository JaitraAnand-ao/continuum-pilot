import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_FOLDER } from './migrate.js'
import { DB_ROLES } from './roles.js'
import { migratedOwnerPool, poolAs, testDatabaseUrl } from './test-database.js'

describe.skipIf(!testDatabaseUrl)('per-role grants (AD-10) for the sign-in tables', () => {
  const url = testDatabaseUrl as string
  let owner: pg.Pool
  const pools: pg.Pool[] = []
  const as = (role: string) => {
    const pool = poolAs(url, role)
    pools.push(pool)
    return pool
  }

  beforeAll(async () => {
    owner = await migratedOwnerPool(url)
  })
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()))
    await owner?.end()
  })

  it('migrating twice is a no-op', async () => {
    const again = await migratedOwnerPool(url)
    await again.end()
  })

  it('creates the group roles without login', async () => {
    const { rows } = await owner.query<{ rolname: string; rolcanlogin: boolean }>(
      'select rolname, rolcanlogin from pg_roles where rolname = any($1) order by rolname',
      [Object.values(DB_ROLES)],
    )
    expect(rows).toEqual(
      Object.values(DB_ROLES)
        .sort()
        .map((rolname) => ({ rolname, rolcanlogin: false })),
    )
  })

  for (const role of [DB_ROLES.reportWorker, DB_ROLES.mailWorker]) {
    it(`${role} can neither read nor write sessions, login transactions or the audit log`, async () => {
      const pool = as(role)
      for (const table of ['sessions', 'login_transactions', 'audit_events']) {
        await expect(pool.query(`select * from ${table}`)).rejects.toThrow(/permission denied/)
        await expect(pool.query(`delete from ${table}`)).rejects.toThrow(/permission denied/)
      }
    })
  }

  it('sr_auditor cannot see sessions or login transactions', async () => {
    const pool = as(DB_ROLES.auditor)
    for (const table of ['sessions', 'login_transactions']) {
      await expect(pool.query(`select * from ${table}`)).rejects.toThrow(/permission denied/)
    }
  })

  it('PUBLIC holds no privilege on the sign-in tables', async () => {
    const { rows } = await owner.query(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'PUBLIC' and table_name in ('sessions', 'login_transactions', 'audit_events')`,
    )
    expect(rows).toEqual([])
  })

  it('grants each role exactly its table privileges on the sign-in tables, and nothing more', async () => {
    const { rows } = await owner.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
        where grantee = any($1) and table_name in ('sessions', 'login_transactions', 'audit_events')
        order by grantee, table_name, privilege_type`,
      [Object.values(DB_ROLES)],
    )
    expect(rows).toEqual([
      { grantee: DB_ROLES.api, table_name: 'login_transactions', privilege_type: 'DELETE' },
      { grantee: DB_ROLES.api, table_name: 'login_transactions', privilege_type: 'INSERT' },
      { grantee: DB_ROLES.api, table_name: 'login_transactions', privilege_type: 'SELECT' },
      { grantee: DB_ROLES.api, table_name: 'sessions', privilege_type: 'DELETE' },
      { grantee: DB_ROLES.api, table_name: 'sessions', privilege_type: 'INSERT' },
      { grantee: DB_ROLES.api, table_name: 'sessions', privilege_type: 'SELECT' },
      { grantee: DB_ROLES.auditor, table_name: 'audit_events', privilege_type: 'SELECT' },
    ])
  })

  it('the role-creation block is idempotent: re-run where the roles exist, still exactly four NOLOGIN roles', async () => {
    const migration = await readFile(join(MIGRATIONS_FOLDER, '0001_sign_in_roles_grants_chain.sql'), 'utf8')
    const block = migration.split('--> statement-breakpoint').find((statement) => statement.includes('CREATE ROLE'))
    expect(block).toBeDefined()
    await expect(owner.query(block as string)).resolves.toBeDefined()
    const { rows } = await owner.query<{ rolname: string; rolcanlogin: boolean }>(
      `select rolname, rolcanlogin from pg_roles where rolname like 'sr\\_%' order by rolname`,
    )
    expect(rows).toEqual(
      Object.values(DB_ROLES)
        .sort()
        .map((rolname) => ({ rolname, rolcanlogin: false })),
    )
  })
})
