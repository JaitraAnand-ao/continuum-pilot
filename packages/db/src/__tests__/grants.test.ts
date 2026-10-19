import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, migratedPool, noDatabase, sqlState } from './db.js'

const INSUFFICIENT_PRIVILEGE = '42501'

const insertSession = (client: pg.PoolClient) =>
  client.query(
    `INSERT INTO sessions (id_hash, subject_oid, account_name, roles, refresh_token_ciphertext, refresh_token_iv,
       refresh_token_tag, refresh_token_key_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, 'a@contoso.example', '{reader}', $3, $4, $5, 'k1', now(), now(),
       now() + interval '15 minutes', now() + interval '8 hours')`,
    [randomBytes(32), randomUUID(), randomBytes(40), randomBytes(12), randomBytes(16)],
  )

const insertAudit = (client: pg.PoolClient) =>
  client.query(
    `INSERT INTO audit_events (occurred_at, event_type, actor_oid, trace_id)
     VALUES (now(), 'access_denied', $1, $2)`,
    [randomUUID(), randomUUID().replaceAll('-', '')],
  )

describe.skipIf(noDatabase)('per-role grants (AD-10)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = await migratedPool()
  })
  afterAll(async () => {
    await pool?.end()
  })

  describe('sr_api', () => {
    it('reads and writes sessions and appends audit events', async () => {
      await asRole(pool, 'sr_api', async (client) => {
        await insertSession(client)
        await client.query('SELECT id_hash FROM sessions')
        await client.query("UPDATE sessions SET last_seen_at = now() WHERE account_name = 'a@contoso.example'")
        await client.query("DELETE FROM sessions WHERE account_name = 'a@contoso.example'")
        await insertAudit(client)
      })
    })

    it('cannot read, alter or remove audit events', async () => {
      for (const statement of [
        'SELECT * FROM audit_events',
        "UPDATE audit_events SET actor_name = 'x'",
        'DELETE FROM audit_events',
        'TRUNCATE audit_events',
      ]) {
        expect(await asRole(pool, 'sr_api', (c) => sqlState(() => c.query(statement)))).toBe(INSUFFICIENT_PRIVILEGE)
      }
    })

    it('cannot run DDL on the tables', async () => {
      expect(await asRole(pool, 'sr_api', (c) => sqlState(() => c.query('DROP TABLE sessions')))).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })
  })

  describe('sr_report_worker', () => {
    it('purges expired sessions', async () => {
      await asRole(pool, 'sr_report_worker', (c) => c.query('DELETE FROM sessions WHERE absolute_expires_at <= now()'))
    })

    it('cannot create sessions or read refresh tokens', async () => {
      expect(await asRole(pool, 'sr_report_worker', (c) => sqlState(() => insertSession(c)))).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(
        await asRole(pool, 'sr_report_worker', (c) =>
          sqlState(() => c.query('SELECT refresh_token_ciphertext FROM sessions')),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE)
    })
  })

  describe('sr_mail_worker', () => {
    it('can touch neither sessions nor the audit log', async () => {
      for (const statement of ['SELECT * FROM sessions', 'SELECT * FROM audit_events', 'DELETE FROM sessions']) {
        expect(await asRole(pool, 'sr_mail_worker', (c) => sqlState(() => c.query(statement)))).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      }
      expect(await asRole(pool, 'sr_mail_worker', (c) => sqlState(() => insertAudit(c)))).toBe(INSUFFICIENT_PRIVILEGE)
    })
  })

  it('grants nothing to PUBLIC', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'PUBLIC' AND table_name IN ('sessions', 'audit_events')`,
    )
    expect(rows).toEqual([])
  })
})
