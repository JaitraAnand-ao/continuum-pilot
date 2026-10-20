import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAuditLog, findAuditChainBreak } from '../audit-log.js'
import { connect } from '../client.js'
import { createRecipientStore, type NewRecipient, type RecipientStore } from '../recipient-store.js'
import { asRole, migratedPool, noDatabase, sqlState } from './db.js'

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'
const RAISE_EXCEPTION = 'P0001'

const traceId = () => randomUUID().replaceAll('-', '')
const admin = { oid: randomUUID(), name: 'admin@contoso.com' }
const approver = { oid: randomUUID(), name: 'approver@contoso.com' }
const at = (iso: string) => new Date(iso)
const context = (occurredAt = at('2026-10-20T09:00:00.000Z')) => ({ actor: admin, traceId: traceId(), occurredAt })

const socTeam = (): NewRecipient => ({
  kind: 'group',
  entraObjectId: randomUUID(),
  displayName: 'SOC team',
  address: 'soc@contoso.com',
  memberCount: 5,
})
const dChen = (): NewRecipient => ({
  kind: 'person',
  entraObjectId: randomUUID(),
  displayName: 'd.chen',
  address: 'd.chen@contoso.com',
  memberCount: null,
})

const auditFor = (pool: pg.Pool, traceIdValue: string) =>
  pool
    .query('SELECT event_type, actor_oid, actor_name, target, occurred_at FROM audit_events WHERE trace_id = $1', [
      traceIdValue,
    ])
    .then((r) => r.rows)

/* Inserts a recipient row directly as the owner, to exercise the table's own guards. */
const insertRow = (client: pg.Pool | pg.PoolClient, overrides: Record<string, unknown> = {}) => {
  const row = {
    kind: 'person',
    entra_object_id: randomUUID(),
    display_name: 'm.vance',
    address: 'm.vance@contoso.com',
    member_count: null,
    status: 'pending_approval',
    added_by_oid: admin.oid,
    added_by_name: admin.name,
    proposed_at: '2026-10-20T09:00:00.000Z',
    approved_by_oid: null,
    approved_by_name: null,
    approved_at: null,
    ...overrides,
  }
  return client.query(
    `INSERT INTO email_recipient (kind, entra_object_id, display_name, address, member_count, status, added_by_oid,
       added_by_name, proposed_at, approved_by_oid, approved_by_name, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    Object.values(row),
  )
}

/* The approval a later story performs: a waiting recipient becomes active, naming its approver. */
const approve = (client: pg.Pool | pg.PoolClient, id: string, overrides: Record<string, unknown> = {}) => {
  const set = {
    status: 'active',
    approved_by_oid: approver.oid,
    approved_by_name: approver.name,
    approved_at: '2026-10-20T10:00:00.000Z',
    ...overrides,
  }
  return client.query(
    `UPDATE email_recipient SET status = $2, approved_by_oid = $3, approved_by_name = $4, approved_at = $5
     WHERE id = $1`,
    [id, ...Object.values(set)],
  )
}

describe.skipIf(noDatabase)('email recipients (ST-18)', () => {
  let pool: pg.Pool
  let store: RecipientStore

  beforeAll(async () => {
    pool = await migratedPool()
    store = createRecipientStore(connect(pool))
  })
  beforeEach(async () => {
    await pool.query('DELETE FROM email_recipient')
  })
  afterAll(async () => {
    await pool?.query('DELETE FROM email_recipient')
    await pool?.end()
  })

  describe('the store', () => {
    it('lists nobody when the list is empty (AC-7)', async () => {
      expect(await store.list()).toEqual([])
    })

    it('sends a person for approval as Waiting for approval, naming who added them (AC-2)', async () => {
      const recipient = dChen()
      const ctx = context()
      const result = await store.propose(recipient, ctx)

      expect(result.outcome).toBe('proposed')
      const expected = {
        ...recipient,
        status: 'pending_approval',
        addedBy: admin,
        proposedAt: ctx.occurredAt,
        approvedBy: null,
        approvedAt: null,
      }
      expect(result.recipient).toMatchObject(expected)
      expect(result.recipient.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(await store.list()).toEqual([result.recipient])
    })

    it('stores a group with its member count (AC-1, AC-4)', async () => {
      const result = await store.propose(socTeam(), context())
      expect(result.recipient).toMatchObject({ kind: 'group', memberCount: 5, displayName: 'SOC team' })
    })

    it('records the proposal in the audit trail with the administrator, in the same transaction (AC-10)', async () => {
      const recipient = dChen()
      const ctx = context()
      await store.propose(recipient, ctx)
      expect(await auditFor(pool, ctx.traceId)).toEqual([
        {
          event_type: 'recipient.proposed',
          actor_oid: admin.oid,
          actor_name: admin.name,
          target: `email_recipient/${recipient.entraObjectId}`,
          occurred_at: ctx.occurredAt,
        },
      ])
    })

    it('saves nothing when the proposal cannot be audited', async () => {
      const state = await sqlState(() => store.propose(dChen(), { ...context(), traceId: 'not-a-trace' }))
      expect(state).toBe(CHECK_VIOLATION)
      expect(await store.list()).toEqual([])
    })

    it('does not list or audit a directory object twice', async () => {
      const recipient = dChen()
      const first = await store.propose(recipient, context())
      const ctx = { actor: approver, traceId: traceId(), occurredAt: at('2026-10-20T12:00:00.000Z') }
      const second = await store.propose({ ...recipient, displayName: 'renamed' }, ctx)

      expect(second).toEqual({ outcome: 'already_listed', recipient: first.recipient })
      expect(second.recipient).toMatchObject({
        displayName: 'd.chen',
        addedBy: admin,
        proposedAt: at('2026-10-20T09:00:00.000Z'),
      })
      expect(await store.list()).toEqual([first.recipient])
      expect(await auditFor(pool, ctx.traceId)).toEqual([])
    })

    it('lists recipients by name regardless of case, active and waiting alike, with who approved them (AC-1)', async () => {
      const soc = await store.propose(socTeam(), context())
      const chen = await store.propose(dChen(), context())
      await approve(pool, soc.recipient.id)

      const listed = await store.list()
      expect(listed.map((r) => [r.displayName, r.status])).toEqual([
        ['d.chen', 'pending_approval'],
        ['SOC team', 'active'],
      ])
      expect(listed[0]).toEqual(chen.recipient)
      expect(listed[1]).toMatchObject({ approvedBy: approver, approvedAt: at('2026-10-20T10:00:00.000Z') })
    })

    it('breaks a tie between names that differ only in case by id', async () => {
      const proposed = []
      for (const displayName of ['alpha', 'Alpha', 'ALPHA', 'beta']) {
        proposed.push((await store.propose({ ...dChen(), displayName }, context())).recipient)
      }
      const tied = proposed.slice(0, 3).sort((a, b) => (a.id < b.id ? -1 : 1))
      expect((await store.list()).map((r) => r.id)).toEqual([...tied, proposed[3]].map((r) => r?.id))
    })

    it('removes a recipient at once, without approval, and audits the removal (AC-6, AC-10)', async () => {
      const soc = await store.propose(socTeam(), context())
      const ctx = context(at('2026-10-20T11:00:00.000Z'))
      const result = await store.remove(soc.recipient.id, ctx)

      expect(result).toEqual({ outcome: 'removed', recipient: soc.recipient })
      expect(await store.list()).toEqual([])
      expect(await auditFor(pool, ctx.traceId)).toEqual([
        {
          event_type: 'recipient.removed',
          actor_oid: admin.oid,
          actor_name: admin.name,
          target: `email_recipient/${soc.recipient.entraObjectId}`,
          occurred_at: ctx.occurredAt,
        },
      ])
    })

    it('reports an unknown recipient as not found and audits nothing', async () => {
      const ctx = context()
      expect(await store.remove(randomUUID(), ctx)).toEqual({ outcome: 'not_found' })
      expect(await auditFor(pool, ctx.traceId)).toEqual([])
    })

    it('keeps the recipient when the removal cannot be audited (AC-8)', async () => {
      const soc = await store.propose(socTeam(), context())
      const state = await sqlState(() => store.remove(soc.recipient.id, { ...context(), traceId: 'not-a-trace' }))
      expect(state).toBe(CHECK_VIOLATION)
      expect(await store.list()).toEqual([soc.recipient])
    })

    it('surfaces a failed write as the driver error, without the bound values or the failing row', async () => {
      const error = (await store
        .propose({ ...dChen(), address: 'd.chen at contoso.com' }, context())
        .catch((e: unknown) => e)) as Error & { code?: string; detail?: string }
      expect(error).not.toBeInstanceOf(DrizzleQueryError)
      expect(error.code).toBe(CHECK_VIOLATION)
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain('d.chen')
      expect(error.detail).toBeUndefined()
    })
  })

  describe('the audit trail', () => {
    it('records a passed, a rejected and a failed membership check naming the administrator (AC-3, AC-5, AC-10)', async () => {
      const audit = createAuditLog(connect(pool))
      for (const type of ['recipient.check_passed', 'recipient.check_rejected', 'recipient.check_failed'] as const) {
        const trace = traceId()
        await audit.record({
          type,
          actorOid: admin.oid,
          actorName: admin.name,
          target: `email_recipient/${randomUUID()}`,
          traceId: trace,
          occurredAt: at('2026-10-20T09:00:00.000Z'),
        })
        expect(await auditFor(pool, trace)).toMatchObject([{ event_type: type, actor_oid: admin.oid }])
      }
      expect(await findAuditChainBreak(connect(pool))).toBeNull()
    })

    it('still rejects an unknown event type', async () => {
      const state = await sqlState(() =>
        pool.query(
          `INSERT INTO audit_events (occurred_at, event_type, trace_id, hash) VALUES (now(), 'recipient.approved', $1, '\\x')`,
          [traceId()],
        ),
      )
      expect(state).toBe(CHECK_VIOLATION)
    })
  })

  describe('the table guards', () => {
    it('accepts a well-formed person and group', async () => {
      await insertRow(pool)
      await insertRow(pool, { kind: 'group', member_count: 1, display_name: 'sec-oncall' })
    })

    it('rejects an unknown kind or status', async () => {
      expect(await sqlState(() => insertRow(pool, { kind: 'robot' }))).toBe(CHECK_VIOLATION)
      expect(await sqlState(() => insertRow(pool, { status: 'removed' }))).toBe(CHECK_VIOLATION)
    })

    it('requires a member count for a group, at least one, and none for a person', async () => {
      expect(await sqlState(() => insertRow(pool, { kind: 'group', member_count: null }))).toBe(CHECK_VIOLATION)
      expect(await sqlState(() => insertRow(pool, { kind: 'group', member_count: 0 }))).toBe(CHECK_VIOLATION)
      expect(await sqlState(() => insertRow(pool, { kind: 'person', member_count: 1 }))).toBe(CHECK_VIOLATION)
    })

    it('requires an address shaped like one mailbox', async () => {
      await insertRow(pool, { address: 'a@b' })
      for (const address of ['', 'soc', 'soc@', '@contoso.com', 'a@b@contoso.com', 'a b@contoso.com']) {
        expect(await sqlState(() => insertRow(pool, { address }))).toBe(CHECK_VIOLATION)
      }
    })

    it('lists a directory object only once', async () => {
      const entraObjectId = randomUUID()
      await insertRow(pool, { entra_object_id: entraObjectId })
      expect(await sqlState(() => insertRow(pool, { entra_object_id: entraObjectId }))).toBe(UNIQUE_VIOLATION)
    })

    it('adds a recipient only as waiting for approval, never already active', async () => {
      const active = {
        status: 'active',
        approved_by_oid: approver.oid,
        approved_by_name: approver.name,
        approved_at: '2026-10-20T10:00:00.000Z',
      }
      expect(await sqlState(() => insertRow(pool, active))).toBe(RAISE_EXCEPTION)
      expect(await asRole(pool, 'sr_api', (c) => sqlState(() => insertRow(c, active)))).toBe(RAISE_EXCEPTION)
      expect(await sqlState(() => insertRow(pool, { approved_by_oid: approver.oid }))).toBe(CHECK_VIOLATION)
    })

    it('makes a recipient active only with an approver, its name and the time', async () => {
      const { id } = (await insertRow(pool)).rows[0]
      for (const missing of ['approved_by_oid', 'approved_by_name', 'approved_at']) {
        expect(await sqlState(() => approve(pool, id, { [missing]: null }))).toBe(CHECK_VIOLATION)
      }
      await approve(pool, id)
    })

    it('never lets the administrator who proposed a recipient approve it (four-eyes)', async () => {
      const { id } = (await insertRow(pool)).rows[0]
      expect(await sqlState(() => approve(pool, id, { approved_by_oid: admin.oid }))).toBe(CHECK_VIOLATION)
      await approve(pool, id)
    })

    it('approves at or after the proposal, never one millisecond before', async () => {
      const early = (await insertRow(pool)).rows[0].id
      expect(await sqlState(() => approve(pool, early, { approved_at: '2026-10-20T08:59:59.999Z' }))).toBe(
        CHECK_VIOLATION,
      )
      await approve(pool, early, { approved_at: '2026-10-20T09:00:00.000Z' })
    })

    it('allows only the approval of a waiting recipient as a change', async () => {
      const { id } = (await insertRow(pool)).rows[0]
      expect(
        await sqlState(() => pool.query("UPDATE email_recipient SET status = 'pending_approval' WHERE id = $1", [id])),
      ).toBe(RAISE_EXCEPTION)
      await approve(pool, id)
      expect(await sqlState(() => approve(pool, id))).toBe(RAISE_EXCEPTION)
      expect(
        await sqlState(() =>
          pool.query(
            `UPDATE email_recipient SET status = 'pending_approval', approved_by_oid = NULL, approved_by_name = NULL,
               approved_at = NULL WHERE id = $1`,
            [id],
          ),
        ),
      ).toBe(RAISE_EXCEPTION)
    })

    it('never changes who or what a recipient is', async () => {
      const { id } = (await insertRow(pool)).rows[0]
      for (const set of [
        "address = 'other@contoso.com'",
        "display_name = 'other'",
        `entra_object_id = '${randomUUID()}'`,
        "kind = 'group', member_count = 3",
        `added_by_oid = '${randomUUID()}'`,
        "added_by_name = 'other'",
        "proposed_at = '2026-10-19T09:00:00.000Z'",
      ]) {
        expect(await sqlState(() => pool.query(`UPDATE email_recipient SET ${set} WHERE id = $1`, [id]))).toBe(
          RAISE_EXCEPTION,
        )
      }
    })

    it('never changes the member count a group was checked with', async () => {
      const { id } = (await insertRow(pool, { kind: 'group', member_count: 5 })).rows[0]
      expect(await sqlState(() => pool.query('UPDATE email_recipient SET member_count = 6 WHERE id = $1', [id]))).toBe(
        RAISE_EXCEPTION,
      )
    })
  })

  describe('per-role grants (AD-10)', () => {
    it('lets the BFF list, add and remove recipients', async () => {
      await asRole(pool, 'sr_api', async (client) => {
        const { id } = (await insertRow(client)).rows[0]
        await client.query('SELECT * FROM email_recipient')
        await client.query('DELETE FROM email_recipient WHERE id = $1', [id])
      })
    })

    it('never lets the BFF approve, rewrite or empty the list', async () => {
      for (const statement of [
        "UPDATE email_recipient SET status = 'active'",
        "UPDATE email_recipient SET address = 'x@contoso.com'",
        'TRUNCATE email_recipient',
      ]) {
        expect(await asRole(pool, 'sr_api', (c) => sqlState(() => c.query(statement)))).toBe(INSUFFICIENT_PRIVILEGE)
      }
    })

    it('lets the mail worker read only the addresses and status it sends by', async () => {
      await asRole(pool, 'sr_mail_worker', (c) =>
        c.query("SELECT address FROM email_recipient WHERE status = 'active'"),
      )
      for (const statement of [
        'SELECT * FROM email_recipient',
        'SELECT added_by_name FROM email_recipient',
        'DELETE FROM email_recipient',
        "UPDATE email_recipient SET status = 'active'",
      ]) {
        expect(await asRole(pool, 'sr_mail_worker', (c) => sqlState(() => c.query(statement)))).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      }
      expect(await asRole(pool, 'sr_mail_worker', (c) => sqlState(() => insertRow(c)))).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('grants the report worker nothing on recipients', async () => {
      expect(
        await asRole(pool, 'sr_report_worker', (c) => sqlState(() => c.query('SELECT address FROM email_recipient'))),
      ).toBe(INSUFFICIENT_PRIVILEGE)
      expect(await asRole(pool, 'sr_report_worker', (c) => sqlState(() => insertRow(c)))).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('grants exactly these privileges, and nothing to PUBLIC', async () => {
      const { rows } = await pool.query(
        `SELECT grantee, privilege_type FROM information_schema.role_table_grants
         WHERE table_name = 'email_recipient' AND grantee IN ('PUBLIC', 'sr_api', 'sr_mail_worker', 'sr_report_worker')
         ORDER BY grantee, privilege_type`,
      )
      expect(rows).toEqual([
        { grantee: 'sr_api', privilege_type: 'DELETE' },
        { grantee: 'sr_api', privilege_type: 'INSERT' },
        { grantee: 'sr_api', privilege_type: 'SELECT' },
      ])
      const columns = await pool.query(
        `SELECT column_name, privilege_type FROM information_schema.column_privileges
         WHERE table_name = 'email_recipient' AND grantee = 'sr_mail_worker' ORDER BY column_name`,
      )
      expect(columns.rows).toEqual([
        { column_name: 'address', privilege_type: 'SELECT' },
        { column_name: 'status', privilege_type: 'SELECT' },
      ])
    })
  })
})
