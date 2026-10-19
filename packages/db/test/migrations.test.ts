/* ST-2 (CMP-5): the committed, forward-only migrations carry what Drizzle cannot express —
 * immutability, the window and reconciliation triggers, and the per-role grants (AD-10). */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = join(import.meta.dirname, '..', 'migrations')
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
const sqlOf = (name: string) => readFileSync(join(dir, name), 'utf8')
const all = files.map(sqlOf).join('\n')
/** Whitespace-normalised, lower-cased SQL so assertions do not depend on layout. */
const flat = all.replace(/\s+/g, ' ').toLowerCase()

describe('the migration set', () => {
  it('is journaled: every SQL file is an entry of the drizzle journal, in order', () => {
    const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[]
    }
    expect(journal.entries.map((e) => `${e.tag}.sql`)).toEqual(files)
    expect(journal.entries.map((e) => e.idx)).toEqual(files.map((_, i) => i))
  })

  it('is forward-only: nothing is dropped', () => {
    expect(flat).not.toMatch(/drop (table|column|type|trigger|function)/)
  })

  it('creates both tables with one report per date', () => {
    expect(flat).toContain('create table "reports"')
    expect(flat).toContain('create table "signin_snapshots"')
    expect(flat).toMatch(/create unique index "reports_report_date_key" on "reports" using btree \("report_date"/)
  })
})

describe('window and reconciliation (AC-1, AC-2, AC-3, AC-7)', () => {
  it('pins the report window to 00:00 UTC of D up to but not including 00:00 UTC of D+1', () => {
    expect(flat).toContain(`"reports"."window_start" = ("reports"."report_date"::timestamp at time zone 'utc')`)
    expect(flat).toContain(`"reports"."window_end" = "reports"."window_start" + interval '1 day'`)
  })

  it('rejects a snapshot sign-in outside the window: 23:59:59.999 is in, 00:00:00.000 of D+1 is out', () => {
    expect(flat).toContain('new.created_at < r.window_start or new.created_at >= r.window_end')
    expect(flat).toMatch(/create trigger signin_snapshots_within_window before insert on signin_snapshots for each row/)
  })

  it('refuses snapshot rows for a report written by an earlier transaction, or recorded as not generated', () => {
    expect(flat).toContain('r.xmin::text <> (txid_current() % 4294967296)::text')
    expect(flat).toContain(`r.status = 'not_generated'`)
  })

  it('reconciles the stored figures to the snapshot at commit, so a zero day must be all zeros', () => {
    expect(flat).toMatch(
      /create constraint trigger reports_reconcile_with_snapshot after insert on reports deferrable initially deferred for each row/,
    )
    expect(flat).toContain('count(*) filter (where s.error_code = 0)')
    expect(flat).toContain('n_total <> new.total_count or n_successful <> new.successful_count')
  })

  it('lets only a whole report be complete, and never a not-generated day', () => {
    expect(flat).toContain(`"reports"."status" = 'complete' and cardinality("reports"."missing_sources") = 0`)
    expect(flat).toContain(
      `"reports"."status" = 'not_generated' and cardinality("reports"."missing_sources") > 0 and "reports"."content_hash" is null and "reports"."published_at" is null`,
    )
  })
})

describe('immutability (AC-4)', () => {
  it('rejects every UPDATE and TRUNCATE of reports and snapshots', () => {
    for (const table of ['reports', 'signin_snapshots']) {
      expect(flat).toContain(
        `create trigger ${table}_reject_update before update on ${table} for each row execute function reject_mutation()`,
      )
      expect(flat).toContain(
        `create trigger ${table}_reject_truncate before truncate on ${table} for each statement execute function reject_mutation()`,
      )
    }
    expect(flat).toMatch(/raise exception '% on % is not allowed: stored reports are immutable'/)
  })
})

describe('per-role grants (AD-10)', () => {
  it('creates the roles idempotently and without login', () => {
    for (const role of ['sr_report_worker', 'sr_api', 'sr_mailer']) {
      expect(flat).toContain(`create role ${role} nologin`)
    }
  })

  it('revokes from PUBLIC and never grants ALL', () => {
    expect(flat).toContain('revoke all on reports, signin_snapshots from public')
    expect(flat).not.toMatch(/grant all/)
  })

  it('lets the report worker insert and read, and nothing more', () => {
    expect(flat).toContain('grant select, insert on reports, signin_snapshots to sr_report_worker')
    expect(flat).not.toMatch(/grant [^;]*(update|delete)[^;]* to sr_report_worker/)
  })

  it('lets the API read reports and snapshots only', () => {
    expect(flat).toContain('grant select on reports, signin_snapshots to sr_api')
    expect(flat).not.toMatch(/grant [^;]*(insert|update|delete)[^;]* to sr_api/)
  })

  it('gives the mailer counts only: no evidence, no hash', () => {
    const mailer = flat.match(/grant [^;]* to sr_mailer/g) ?? []
    expect(mailer).toEqual([
      'grant select (id, report_date, status, missing_sources, total_count, successful_count, failed_count, published_at) on reports to sr_mailer',
    ])
  })
})
