/* Runs against a real Postgres when SR_DB_TEST_URL names a superuser connection, e.g.
 * SR_DB_TEST_URL=postgres://signin_reports:signin_reports@localhost:5432/signin_reports
 * with `docker compose up postgres`. It applies the committed migrations as sr_migrator to
 * a throwaway database and drops it afterwards. Under CI a missing URL fails, never skips. */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createSessionStore,
  hashSessionId,
  recordAuditEvent,
  verifyAuditChain,
  type NewSession,
  type StoredAuditEntry,
} from '../src/index.js'

const adminUrl = process.env.SR_DB_TEST_URL
const roles = ['sr_migrator', 'sr_api', 'sr_report_worker', 'sr_mail_worker'] as const
const migrationsFolder = join(import.meta.dirname, '..', 'migrations')

it('the integration suite finds the committed migrations it applies', () => {
  expect(existsSync(join(migrationsFolder, 'meta', '_journal.json'))).toBe(true)
})

it('runs against real Postgres under CI instead of skipping', () => {
  if (process.env.CI) expect(adminUrl, 'SR_DB_TEST_URL must be set when CI is').toBeDefined()
})

describe.skipIf(!adminUrl)('db against real Postgres', () => {
  const database = `sr_it_${randomBytes(6).toString('hex')}`
  let admin: pg.Client
  let client: pg.Client
  let databaseUrl: string

  /* Runs one statement as the given role, inside a transaction that is always rolled back. */
  async function as(role: string, text: string, values: unknown[] = []) {
    await client.query('BEGIN')
    try {
      await client.query(`SET LOCAL ROLE ${role}`)
      return await client.query(text, values)
    } finally {
      await client.query('ROLLBACK')
    }
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    for (const role of roles) {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
      if (rowCount === 0) await admin.query(`CREATE ROLE ${role} NOLOGIN`)
    }
    await admin.query(`CREATE DATABASE ${database}`)
    await admin.query(`GRANT CREATE ON DATABASE ${database} TO sr_migrator`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    databaseUrl = url.toString()
    client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    await client.query('GRANT CREATE ON SCHEMA public TO sr_migrator')
    /* As in production, the migrator owns what the migrations create and gives the grants. */
    await client.query('SET ROLE sr_migrator')
    try {
      await migrate(drizzle(client), { migrationsFolder })
    } finally {
      await client.query('RESET ROLE')
    }
  })

  afterAll(async () => {
    await client?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${database}`)
    await admin?.end()
  })

  async function readAuditChain(): Promise<StoredAuditEntry[]> {
    const { rows } = await client.query(
      'SELECT seq, occurred_at, event_type, actor_oid, trace_id, reason, prev_hash, hash FROM audit_event ORDER BY seq',
    )
    return rows.map((row) => ({
      seq: Number(row.seq),
      occurredAt: row.occurred_at,
      type: row.event_type,
      actorOid: row.actor_oid,
      traceId: row.trace_id,
      reason: row.reason,
      prevHash: row.prev_hash,
      hash: row.hash,
    }))
  }

  const createdAt = new Date('2026-10-19T08:00:00.000Z')
  const session = (sessionId: string, overrides: Partial<NewSession> = {}): NewSession => ({
    sessionId,
    subjectOid: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    accountName: 'reader@contoso.example',
    roles: ['reader'],
    refreshToken: { ciphertext: randomBytes(48), iv: randomBytes(12), tag: randomBytes(16) },
    idpSessionId: 'kc-session-1',
    createdAt,
    idleExpiresAt: new Date('2026-10-19T08:15:00.000Z'),
    absoluteExpiresAt: new Date('2026-10-19T16:00:00.000Z'),
    ...overrides,
  })

  it('stores only the SHA-256 of the session ID', async () => {
    await createSessionStore(client).create(session('cookie-hash'))
    const { rows } = await client.query<{ id_hash: Buffer }>(
      'SELECT id_hash FROM session WHERE account_name = $1 AND created_at = $2',
      ['reader@contoso.example', createdAt],
    )
    expect(rows.some((row) => row.id_hash.equals(hashSessionId('cookie-hash')))).toBe(true)
    const dump = await client.query('SELECT row_to_json(s)::text AS json FROM session s')
    expect(dump.rows.map((row) => row.json).join()).not.toContain('cookie-hash')
  })

  it('is live one millisecond before the idle limit and gone at it', async () => {
    const store = createSessionStore(client)
    await store.create(session('cookie-idle'))
    expect(await store.findLive('cookie-idle', new Date('2026-10-19T08:14:59.999Z'))).not.toBeNull()
    expect(await store.findLive('cookie-idle', new Date('2026-10-19T08:15:00.000Z'))).toBeNull()
  })

  it('stays capped at 8 hours however often it is touched', async () => {
    const store = createSessionStore(client)
    await store.create(session('cookie-absolute', { idleExpiresAt: new Date('2026-10-19T08:15:00.000Z') }))
    const lastTouch = new Date('2026-10-19T15:55:00.000Z')
    for (let at = createdAt.getTime() + 10 * 60_000; at <= lastTouch.getTime(); at += 10 * 60_000) {
      expect(await store.touch('cookie-absolute', new Date(at), new Date(at + 15 * 60_000))).toBe(true)
    }
    expect(await store.findLive('cookie-absolute', new Date('2026-10-19T15:59:59.999Z'))).not.toBeNull()
    expect(await store.findLive('cookie-absolute', new Date('2026-10-19T16:00:00.000Z'))).toBeNull()
    expect(
      await store.touch('cookie-absolute', new Date('2026-10-19T16:01:00.000Z'), new Date('2026-10-19T16:16:00.000Z')),
    ).toBe(false)
  })

  it('refuses a session longer than 8 hours or an idle window longer than 15 minutes', async () => {
    const store = createSessionStore(client)
    await expect(
      store.create(session('cookie-long', { absoluteExpiresAt: new Date('2026-10-19T16:00:00.001Z') })),
    ).rejects.toThrow(/check constraint/)
    await expect(
      store.create(session('cookie-idle-long', { idleExpiresAt: new Date('2026-10-19T08:15:00.001Z') })),
    ).rejects.toThrow(/check constraint/)
  })

  it('ends the session at logout and the old cookie finds nothing', async () => {
    const store = createSessionStore(client)
    await store.create(session('cookie-logout'))
    const now = new Date('2026-10-19T08:05:00.000Z')
    expect(await store.end('cookie-logout', now, 'logout')).toBe('kc-session-1')
    expect(await store.findLive('cookie-logout', now)).toBeNull()
    expect(await store.end('cookie-logout', now, 'logout')).toBeNull()
  })

  it('an ended session cannot be revived, even by the API role', async () => {
    const store = createSessionStore(client)
    await store.create(session('cookie-revive'))
    const now = new Date('2026-10-19T08:05:00.000Z')
    expect(await store.end('cookie-revive', now, 'logout')).toBe('kc-session-1')
    await client.query('SET ROLE sr_api')
    try {
      await expect(
        client.query('UPDATE session SET ended_at = NULL, end_reason = NULL WHERE id_hash = $1', [
          hashSessionId('cookie-revive'),
        ]),
      ).rejects.toThrow(/has ended/)
      expect(await store.findLive('cookie-revive', now)).toBeNull()
    } finally {
      await client.query('RESET ROLE')
    }
  })

  it('rotates at login: the replaced session ends', async () => {
    const store = createSessionStore(client)
    await store.create(session('cookie-before'))
    await store.create(session('cookie-after'), { replaces: 'cookie-before' })
    const now = new Date('2026-10-19T08:01:00.000Z')
    expect(await store.findLive('cookie-before', now)).toBeNull()
    expect(await store.findLive('cookie-after', now)).not.toBeNull()
  })

  it('the API role can create, read, touch and end a session', async () => {
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL ROLE sr_api')
      const store = createSessionStore(client)
      await store.create(session('cookie-as-api'))
      const now = new Date('2026-10-19T08:05:00.000Z')
      expect(await store.touch('cookie-as-api', now, new Date('2026-10-19T08:20:00.000Z'))).toBe(true)
      expect(await store.findLive('cookie-as-api', now)).not.toBeNull()
      expect(await store.end('cookie-as-api', now, 'logout')).toBe('kc-session-1')
    } finally {
      await client.query('ROLLBACK')
    }
  })

  it.each([
    ['sr_api', 'DELETE FROM session'],
    ['sr_api', "UPDATE session SET roles = '{reader,report_admin}'"],
    ['sr_api', "UPDATE session SET absolute_expires_at = now() + interval '1 day'"],
    ['sr_api', 'SELECT * FROM audit_event'],
    ['sr_api', 'UPDATE audit_event SET reason = NULL'],
    ['sr_api', 'DELETE FROM audit_event'],
    ['sr_api', 'TRUNCATE audit_event'],
    ['sr_report_worker', 'SELECT * FROM session'],
    ['sr_report_worker', 'SELECT * FROM audit_event'],
    ['sr_mail_worker', 'SELECT * FROM session'],
    ['sr_mail_worker', 'SELECT * FROM audit_event'],
  ])('%s is denied: %s', async (role, statement) => {
    await expect(as(role, statement)).rejects.toThrow(/permission denied/)
  })

  it('records an access-denied event as the API role and the chain verifies', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    await client.query('SET ROLE sr_api')
    try {
      await recordAuditEvent(client, {
        occurredAt: new Date('2026-10-19T08:00:01.250Z'),
        type: 'access_denied',
        actorOid: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
        traceId,
        reason: 'no_reader_role',
      })
      await recordAuditEvent(client, {
        occurredAt: new Date('2026-10-19T08:00:02.000Z'),
        type: 'sign_in_failed',
        actorOid: null,
        traceId,
        reason: 'AADSTS50126',
      })
    } finally {
      await client.query('RESET ROLE')
    }
    const entries = await readAuditChain()
    expect(entries.map((entry) => entry.type)).toEqual(['access_denied', 'sign_in_failed'])
    expect(verifyAuditChain(entries)).toEqual({ ok: true, entries: 2 })
  })

  it('ignores a caller-supplied hash and sequence', async () => {
    await client.query(
      `INSERT INTO audit_event (seq, occurred_at, event_type, trace_id, prev_hash, hash)
       VALUES (999, now(), 'sign_out', '4bf92f3577b34da6a3ce929d0e0e4736', '\\x00', '\\x00')`,
    )
    const { rows } = await client.query(
      'SELECT seq, octet_length(hash) AS length FROM audit_event ORDER BY seq DESC LIMIT 1',
    )
    expect(Number(rows[0].seq)).not.toBe(999)
    expect(rows[0].length).toBe(32)
  })

  it('chains audit events written concurrently from two API connections without a gap', async () => {
    const writers = [new pg.Client({ connectionString: databaseUrl }), new pg.Client({ connectionString: databaseUrl })]
    try {
      for (const writer of writers) {
        await writer.connect()
        await writer.query('SET ROLE sr_api')
      }
      const before = (await readAuditChain()).length
      await Promise.all(
        writers.flatMap((writer, w) =>
          Array.from({ length: 20 }, (_, i) =>
            recordAuditEvent(writer, {
              occurredAt: new Date(Date.UTC(2026, 9, 19, 9, w, i)),
              type: 'access_denied',
              actorOid: null,
              traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
              reason: `writer_${w}_${i}`,
            }),
          ),
        ),
      )
      const entries = await readAuditChain()
      expect(entries).toHaveLength(before + 40)
      expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index + 1))
      expect(verifyAuditChain(entries)).toEqual({ ok: true, entries: entries.length })
    } finally {
      await Promise.all(writers.map((writer) => writer.end()))
    }
  })

  it('refuses to change or remove an audit event even for its owner', async () => {
    await expect(client.query('UPDATE audit_event SET reason = NULL')).rejects.toThrow(/append-only/)
    await expect(client.query('DELETE FROM audit_event')).rejects.toThrow(/append-only/)
    await expect(client.query('TRUNCATE audit_event')).rejects.toThrow(/append-only/)
  })
})
