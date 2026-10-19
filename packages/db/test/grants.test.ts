/* AD-10 least privilege: each deployable's role gets only what ST-1 needs on the session and
 * audit tables. The API reads and writes sessions and appends audit events; the report worker
 * may only purge expired sessions (never read a refresh token) and append audit events; the
 * mail worker touches neither. Nobody may rewrite the audit log. */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordAuditEvent } from '../src/audit-log.js'
import { createSession, findActiveSession, purgeExpiredSessions } from '../src/session-store.js'
import { createTestDatabase, databaseUrl, fixedClock, sqlState, type TestDatabase } from './support/database.js'

const DENIED = '42501'
const TRACE = '0af7651916cd43dd8448eb211c80319c'
const LOGIN = '2026-10-19T08:00:00.000Z'
const clock = fixedClock(LOGIN)
const later = (minutes: number) => new Date(Date.parse(LOGIN) + minutes * 60_000)

const aSession = () => ({
  sessionId: randomBytes(32).toString('base64url'),
  subject: 'sub',
  accountName: 'reader@contoso.example',
  roles: ['reader' as const],
  refreshToken: { ciphertext: randomBytes(32), iv: randomBytes(12), tag: randomBytes(16) },
  keycloakSessionId: null,
  idleExpiresAt: later(15),
  absoluteExpiresAt: later(480),
})

describe.skipIf(!databaseUrl)('per-role grants (AD-10)', () => {
  let t: TestDatabase

  beforeAll(async () => {
    t = await createTestDatabase()
  })
  afterAll(async () => {
    await t?.drop()
  })

  describe('sr_api', () => {
    it('creates, reads, touches and ends sessions and appends audit events', async () => {
      await t.asRole('sr_api', async (db, client) => {
        const s = aSession()
        await createSession(db, clock, s)
        expect(await findActiveSession(db, clock, s.sessionId)).not.toBeNull()
        await client.query('UPDATE session SET last_seen_at = last_seen_at')
        await client.query('DELETE FROM session')
        await recordAuditEvent(db, clock, { type: 'access_denied', actor: 'outsider@contoso.example', traceId: TRACE })
      })
    })

    it('cannot read, rewrite or truncate the audit log', async () => {
      await t.asRole('sr_api', async (_db, client) => {
        expect(await sqlState(client.query('SELECT * FROM audit_event'))).toBe(DENIED)
        expect(await sqlState(client.query("UPDATE audit_event SET actor = 'x'"))).toBe(DENIED)
        expect(await sqlState(client.query('DELETE FROM audit_event'))).toBe(DENIED)
        expect(await sqlState(client.query('TRUNCATE audit_event'))).toBe(DENIED)
      })
    })

    it('cannot change the schema', async () => {
      await t.asRole('sr_api', async (_db, client) => {
        expect(await sqlState(client.query('CREATE TABLE sneaky (id int)'))).toBe(DENIED)
        expect(await sqlState(client.query('ALTER TABLE session DISABLE TRIGGER ALL'))).toBe(DENIED)
      })
    })
  })

  describe('sr_report_worker', () => {
    it('purges expired sessions and appends audit events', async () => {
      await createSession(t.db, clock, aSession())
      await t.asRole('sr_report_worker', async (db) => {
        expect(await purgeExpiredSessions(db, fixedClock(later(480).toISOString()))).toBe(1)
        await recordAuditEvent(db, clock, { type: 'session_expired', actor: 'reader@contoso.example', traceId: TRACE })
      })
    })

    it('cannot read a refresh token or an account, create a session or read the audit log', async () => {
      await t.asRole('sr_report_worker', async (db, client) => {
        expect(await sqlState(client.query('SELECT refresh_token_ciphertext FROM session'))).toBe(DENIED)
        expect(await sqlState(client.query('SELECT account_name FROM session'))).toBe(DENIED)
        expect(await sqlState(createSession(db, clock, aSession()))).toBe(DENIED)
        expect(await sqlState(client.query('SELECT * FROM audit_event'))).toBe(DENIED)
      })
    })
  })

  describe('sr_mail_worker', () => {
    it('cannot touch sessions or the audit log', async () => {
      await t.asRole('sr_mail_worker', async (db, client) => {
        expect(await sqlState(client.query('SELECT 1 FROM session'))).toBe(DENIED)
        expect(await sqlState(client.query('DELETE FROM session'))).toBe(DENIED)
        expect(await sqlState(client.query('SELECT 1 FROM audit_event'))).toBe(DENIED)
        expect(
          await sqlState(recordAuditEvent(db, clock, { type: 'sign_in', actor: 'a@contoso.example', traceId: TRACE })),
        ).toBe(DENIED)
      })
    })
  })

  it('grants nothing on the tables to PUBLIC', async () => {
    const { rows } = await t.pool.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'PUBLIC' AND table_schema = 'public'`,
    )
    expect(rows).toEqual([])
  })
})
