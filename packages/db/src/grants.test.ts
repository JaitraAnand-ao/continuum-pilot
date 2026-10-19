import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DB_ROLES, createDb, runMigrations } from './index.js'
import { asRole, createFreshDatabase, testDatabaseUrl, type FreshDatabase } from './test-support.js'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const DENIED = /permission denied/

const insertSession = `INSERT INTO sessions (id_hash, subject, account_name, roles, refresh_token_ciphertext, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
  VALUES ($1, 's', 'a@contoso.example', '{reader}', $2, '2026-10-19T08:00:00Z', '2026-10-19T08:00:00Z', '2026-10-19T08:15:00Z', '2026-10-19T16:00:00Z')`
const insertAudit = `INSERT INTO audit_events (occurred_at, event_type, subject, reason, trace_id) VALUES (now(), 'access_denied', 's', 'missing_reader_role', '${TRACE}')`

describe.skipIf(!testDatabaseUrl)('per-role grants (least privilege, on real Postgres)', () => {
  let fresh: FreshDatabase

  beforeAll(async () => {
    fresh = await createFreshDatabase(testDatabaseUrl as string)
    await runMigrations(createDb(fresh.pool))
  })
  afterAll(async () => {
    await fresh?.drop()
  })

  it('names the three runtime roles', () => {
    expect(DB_ROLES).toEqual({ api: 'sr_api', reportWorker: 'sr_report_worker', mailWorker: 'sr_mail_worker' })
  })

  it('the API reads and writes sessions and appends audit events', async () => {
    await asRole(fresh.pool, DB_ROLES.api, async (c) => {
      await c.query(insertSession, [Buffer.alloc(32, 1), Buffer.alloc(40, 2)])
      await c.query(`UPDATE sessions SET last_seen_at = '2026-10-19T08:01:00Z' WHERE id_hash = $1`, [
        Buffer.alloc(32, 1),
      ])
      expect((await c.query('SELECT subject FROM sessions')).rowCount).toBe(1)
      await c.query(insertAudit)
      await c.query(`DELETE FROM sessions WHERE id_hash = $1`, [Buffer.alloc(32, 1)])
    })
  })

  it('the API cannot read, rewrite or delete audit events, nor create tables', async () => {
    await asRole(fresh.pool, DB_ROLES.api, async (c) => {
      await expect(c.query('SELECT * FROM audit_events')).rejects.toThrow(DENIED)
      await expect(c.query(`UPDATE audit_events SET subject = 'x'`)).rejects.toThrow(DENIED)
      await expect(c.query('DELETE FROM audit_events')).rejects.toThrow(DENIED)
      await expect(c.query('CREATE TABLE sneaky (id int)')).rejects.toThrow(DENIED)
    })
  })

  it('the report worker cannot read sessions or audit events but can run the session purge', async () => {
    await asRole(fresh.pool, DB_ROLES.reportWorker, async (c) => {
      await expect(c.query('SELECT * FROM sessions')).rejects.toThrow(DENIED)
      await expect(c.query('DELETE FROM sessions')).rejects.toThrow(DENIED)
      await expect(c.query('SELECT * FROM audit_events')).rejects.toThrow(DENIED)
      await expect(c.query(insertAudit)).rejects.toThrow(DENIED)
      const { rows } = await c.query(`SELECT purge_expired_sessions('2026-10-19T09:00:00Z') AS purged`)
      expect(rows[0].purged).toBe(0)
    })
  })

  it('the report worker purge deletes the expired session and keeps the live one', async () => {
    const expired = Buffer.alloc(32, 11)
    const live = Buffer.alloc(32, 12)
    await fresh.pool.query(insertSession, [expired, Buffer.alloc(40, 2)])
    await fresh.pool.query(
      `INSERT INTO sessions (id_hash, subject, account_name, roles, refresh_token_ciphertext, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
        VALUES ($1, 's', 'b@contoso.example', '{reader}', $2, '2026-10-19T16:00:00Z', '2026-10-19T16:00:00Z', '2026-10-19T16:15:00Z', '2026-10-20T00:00:00Z')`,
      [live, Buffer.alloc(40, 2)],
    )
    const purged = await asRole(fresh.pool, DB_ROLES.reportWorker, async (c) => {
      const { rows } = await c.query(`SELECT purge_expired_sessions('2026-10-19T16:05:00Z') AS purged`)
      return rows[0].purged
    })
    expect(purged).toBe(1)
    const { rows } = await fresh.pool.query<{ id_hash: Buffer }>('SELECT id_hash FROM sessions')
    expect(rows.map((r) => r.id_hash.toString('hex'))).toEqual([live.toString('hex')])
  })

  it('the mail worker can touch neither sessions nor audit events, nor purge', async () => {
    await asRole(fresh.pool, DB_ROLES.mailWorker, async (c) => {
      await expect(c.query('SELECT * FROM sessions')).rejects.toThrow(DENIED)
      await expect(c.query(insertSession, [Buffer.alloc(32, 3), Buffer.alloc(40, 2)])).rejects.toThrow(DENIED)
      await expect(c.query('SELECT * FROM audit_events')).rejects.toThrow(DENIED)
      await expect(c.query(insertAudit)).rejects.toThrow(DENIED)
      await expect(c.query(`SELECT purge_expired_sessions(now())`)).rejects.toThrow(DENIED)
    })
  })

  it('the API cannot run the purge either: only the job may', async () => {
    await asRole(fresh.pool, DB_ROLES.api, async (c) => {
      await expect(c.query(`SELECT purge_expired_sessions(now())`)).rejects.toThrow(DENIED)
    })
  })

  it('no runtime role can reach the hash-chain internals', async () => {
    for (const role of Object.values(DB_ROLES)) {
      await asRole(fresh.pool, role, async (c) => {
        await expect(
          c.query(`SELECT audit_event_digest(NULL, 1, now(), 'sign_in', NULL, NULL, '${TRACE}')`),
        ).rejects.toThrow(DENIED)
      })
    }
  })
})
