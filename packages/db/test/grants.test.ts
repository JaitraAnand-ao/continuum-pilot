import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  INSUFFICIENT_PRIVILEGE,
  migratedPool,
  noDatabase,
  publish,
  RECORD_NOT_GENERATED,
  report,
  rolledBack,
  signIn,
  sqlState,
  tryPublish,
} from './support.js'

const NOT_GENERATED = ['2026-10-10', ['identityProtection.riskDetections'], '2026-10-11T07:00:00Z']

describe.skipIf(noDatabase)('report grants (AD-10)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = await migratedPool()
  })
  afterAll(async () => {
    await pool?.end()
  })

  const denied = (role: string, statement: string, values: unknown[] = [], seed = true) =>
    rolledBack(
      pool,
      async (client) => {
        if (seed) {
          await client.query('RESET ROLE')
          await publish(client, report('2026-10-11', [signIn()]))
          await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(role)}`)
        }
        return sqlState(client, statement, values)
      },
      role,
    )

  describe('sr_report_worker', () => {
    it('publishes and reads reports, and records and re-records a not-generated day', async () => {
      await rolledBack(
        pool,
        async (client) => {
          expect(await tryPublish(client, report('2026-10-11', [signIn()]))).toBe(null)
          expect(await tryPublish(client, report('2026-10-11', [signIn()]))).toBe(null)
          await client.query(`SELECT snapshot, content_hash FROM report WHERE report_date = '2026-10-11'`)
          await client.query(RECORD_NOT_GENERATED, NOT_GENERATED)
          await client.query(RECORD_NOT_GENERATED, NOT_GENERATED)
          await client.query('SELECT * FROM report_not_generated')
        },
        'sr_report_worker',
      )
    })

    it('can neither change nor remove a published report', async () => {
      for (const statement of [
        `UPDATE report SET status = 'incomplete'`,
        'DELETE FROM report',
        'TRUNCATE report',
        'DELETE FROM report_not_generated',
        'DROP TABLE report',
      ]) {
        expect(await denied('sr_report_worker', statement)).toBe(INSUFFICIENT_PRIVILEGE)
      }
    })
  })

  describe('sr_api', () => {
    it('reads reports and not-generated days', async () => {
      await rolledBack(
        pool,
        async (client) => {
          await client.query('SELECT * FROM report')
          await client.query('SELECT * FROM report_not_generated')
        },
        'sr_api',
      )
    })

    it('writes nothing', async () => {
      expect(await denied('sr_api', 'INSERT INTO report SELECT * FROM report', [])).toBe(INSUFFICIENT_PRIVILEGE)
      expect(await denied('sr_api', `UPDATE report SET status = 'incomplete'`)).toBe(INSUFFICIENT_PRIVILEGE)
      expect(await denied('sr_api', 'DELETE FROM report')).toBe(INSUFFICIENT_PRIVILEGE)
      expect(await denied('sr_api', RECORD_NOT_GENERATED, NOT_GENERATED)).toBe(INSUFFICIENT_PRIVILEGE)
    })
  })

  describe('sr_mail_worker', () => {
    it('reads only the counts of a report', async () => {
      await rolledBack(
        pool,
        async (client) => {
          await client.query(
            `SELECT report_date, window_start, window_end, status, missing_sources, total, successful, failed, published_at
               FROM report`,
          )
        },
        'sr_mail_worker',
      )
    })

    it('cannot read the snapshot evidence, the not-generated days, or write anything', async () => {
      for (const statement of [
        'SELECT snapshot FROM report',
        'SELECT * FROM report',
        'SELECT * FROM report_not_generated',
        'DELETE FROM report',
      ]) {
        expect(await denied('sr_mail_worker', statement, [], false)).toBe(INSUFFICIENT_PRIVILEGE)
      }
      expect(await denied('sr_mail_worker', RECORD_NOT_GENERATED, NOT_GENERATED, false)).toBe(INSUFFICIENT_PRIVILEGE)
    })
  })

  it('grants nothing to PUBLIC', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'PUBLIC' AND table_name IN ('report', 'report_not_generated')`,
    )
    expect(rows).toEqual([])
  })
})
